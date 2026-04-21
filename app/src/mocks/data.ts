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
    { dur: 30, title: 'NHK ニュースおはよう日本 早朝', genre: 'news' },
    { dur: 90, title: 'NHK ニュース おはよう日本',    genre: 'news' },
    { dur: 15, title: '連続テレビ小説',            genre: 'drama', series: 'asadora', ep: '#58' },
    { dur: 30, title: 'あさイチ オープニング',       genre: 'var'  },
    { dur: 60, title: 'あさイチ',                  genre: 'var'  },
    { dur: 30, title: 'ごごナマ',                  genre: 'var'  },
    { dur: 180, title: '国会中継',                 genre: 'other', desc: '予算委員会 午後の部。' },
    { dur: 30, title: 'NHK ニュース7',              genre: 'news' },
    { dur: 30, title: 'クローズアップ現代',          genre: 'doc'  },
    { dur: 60, title: 'ダーウィンが来た！',          genre: 'doc',   series: 'darwin', ep: '#824', desc: '深海の巨大イカに迫る。', demo: 'series-tvdb-rec', tvdbId: 10001 },
    { dur: 30, title: 'ガッテン！',                 genre: 'var'  },
    { dur: 55, title: 'NHK スペシャル',              genre: 'doc',   series: 'nhk-special', ep: '#1082', desc: '巨大地震 最新研究。', demo: 'series-tvdb-rec', tvdbId: 10002 },
    { dur: 15, title: 'ニュースウオッチ9',            genre: 'news' },
    { dur: 30, title: 'きょうの料理',               genre: 'edu'  },
    { dur: 30, title: '鶴瓶の家族に乾杯',            genre: 'var'  },
    { dur: 30, title: 'ドキュメント72時間',          genre: 'doc',   series: 'doc72h', desc: '深夜のコンビニ。' },
    { dur: 30, title: 'NHK ニュース845',             genre: 'news' },
    { dur: 60, title: '映像の世紀 バタフライエフェクト', genre: 'doc'  },
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
    { dur: 30, title: '趣味の園芸',                  genre: 'edu'  },
    { dur: 30, title: '将棋フォーカス',              genre: 'var'  },
    { dur: 90, title: 'こどもアニメ劇場',            genre: 'anime' },
    { dur: 30, title: 'サイエンスZERO',              genre: 'doc'  },
    { dur: 60, title: 'クラシック音楽館',             genre: 'other', desc: 'N響定期演奏会。' },
    { dur: 30, title: '100分 de 名著',               genre: 'edu'  },
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
    { dur: 120, title: 'ZIP！',                    genre: 'news' },
    { dur: 90, title: 'スッキリ',                   genre: 'var'  },
    { dur: 60, title: 'DAY DAY.',                  genre: 'var'  },
    { dur: 30, title: 'ヒルナンデス！前半',           genre: 'var'  },
    { dur: 60, title: 'ヒルナンデス！後半',           genre: 'var'  },
    { dur: 60, title: '昼の情報 リラックス',          genre: 'var'  },
    { dur: 60, title: 'ミヤネ屋',                  genre: 'news' },
    { dur: 60, title: 'news every.',               genre: 'news' },
    { dur: 60, title: 'ニュースZERO プレ',            genre: 'news' },
    { dur: 60, title: '世界の果てまでイッテQ!',       genre: 'var',   series: 'itteq', ep: '#612', demo: 'series-tvdb-rec', tvdbId: 10003 },
    { dur: 60, title: '行列のできる相談所',           genre: 'var'  },
    { dur: 30, title: 'NEWS ZERO',                 genre: 'news' },
    { dur: 60, title: 'ヒューマングルメンタリー',       genre: 'var'  },
    { dur: 60, title: '金曜ロードショー ナイル殺人事件', genre: 'movie', desc: '名探偵ポアロ最新作。', demo: 'movie-tvdb-rec', tvdbId: 20002 },
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
    { dur: 60, title: '報道ステーション',            genre: 'news' },
    { dur: 60, title: '金曜ナイトドラマ',             genre: 'drama', series: 'kinyou-drama', ep: '#8' },
    { dur: 60, title: '相棒 再放送',                 genre: 'drama', series: 'aibou', ep: '#24', demo: 'series-plain-rec' },
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
    { dur: 60, title: 'プレバト！',                  genre: 'var', series: 'prebat', ep: '#412', demo: 'series-plain-rec' },
    { dur: 120, title: '金曜ドラマ',                 genre: 'drama', series: 'nichigeki-2026q2', ep: '#6', desc: '急転の第6話。', demo: 'series-plain-rec' },
    { dur: 60, title: '中居正広の金スマ',            genre: 'var'  },
    { dur: 30, title: 'NEWS23',                    genre: 'news' },
    { dur: 60, title: 'A-Studio+',                  genre: 'var'  },
    { dur: 30, title: '情熱大陸',                   genre: 'doc',   series: 'jonetsu', demo: 'series-plain-free' },
    { dur: 60, title: 'マツコの知らない世界 再放送',   genre: 'var'  },
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
    { dur: 60, title: 'WBS ワールドビジネスサテライト', genre: 'news' },
    { dur: 60, title: 'アド街ック天国',              genre: 'var'  },
    { dur: 60, title: 'たけしのTVタックル',           genre: 'var'  },
    { dur: 60, title: '太川・蛭子の路線バスの旅',       genre: 'var'  },
    { dur: 60, title: 'カンブリア宮殿',              genre: 'doc'  },
    { dur: 60, title: 'ガイアの夜明け',              genre: 'doc'  },
    { dur: 30, title: 'ポツンと一軒家',              genre: 'var',   series: 'potsun' },
    { dur: 60, title: '日経プラス10',                genre: 'news' },
    { dur: 30, title: '開運！なんでも鑑定団',         genre: 'var'  },
    { dur: 60, title: 'テレ東系アニメ枠',             genre: 'anime', series: 'pokemon', ep: '#1288' },
    { dur: 60, title: '深夜のBSテレ東クロス',         genre: 'other' },
    { dur: 90, title: '特撮シネマ ゴジラ vs モスラ',  genre: 'movie', demo: 'movie-plain-rec' },
    { dur: 120, title: '朝まで再放送',                genre: 'other' },
  ],
  cx: [
    { dur: 150, title: 'めざましテレビ',             genre: 'news' },
    { dur: 60, title: 'とくダネ！',                  genre: 'news' },
    { dur: 90, title: 'ノンストップ！',               genre: 'var'  },
    { dur: 90, title: 'バイキングMORE',              genre: 'var'  },
    { dur: 60, title: 'Live News it!',              genre: 'news' },
    { dur: 60, title: 'みんなのニュース',             genre: 'news' },
    { dur: 60, title: '金曜プレミアム 劇場版アニメ特集', genre: 'movie', series: 'kinyou-cinema', desc: '劇場版アニメ特集。', demo: 'movie-tvdb-rec', tvdbId: 20001 },
    { dur: 60, title: 'VS 嵐 リマスター',            genre: 'var'  },
    { dur: 60, title: 'ネプリーグ',                  genre: 'var'  },
    { dur: 60, title: '世にも奇妙な物語',             genre: 'drama', demo: 'series-plain-free' },
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
    { dur: 30, title: 'アニメイズム',                 genre: 'anime', series: 'euph-2026', ep: '#8', demo: 'series-tvdb-free', tvdbId: 10004 },
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
    { dur: 120, title: 'MLB 中継',                   genre: 'other', series: 'mlb', desc: 'ヤンキース vs レッドソックス。' },
    { dur: 60, title: '国際報道 2026',                genre: 'news' },
    { dur: 60, title: 'ダーウィンが来た！ 再放送',     genre: 'doc', series: 'darwin', ep: '#823', demo: 'series-tvdb-free', tvdbId: 10001 },
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
    { dur: 90, title: 'BSP シネマ 劇場版アニメ再放送', genre: 'movie', demo: 'movie-tvdb-free', tvdbId: 20001 },
    { dur: 60, title: 'NHKスペシャル 再放送',          genre: 'doc', series: 'nhk-special', ep: '#1081', demo: 'series-tvdb-free', tvdbId: 10002 },
    { dur: 60, title: '世界ふれあい街歩き',            genre: 'doc'  },
    { dur: 120, title: 'プレミアムシネマ 名探偵ポアロ', genre: 'movie', series: 'bsp-cinema', demo: 'movie-tvdb-free', tvdbId: 20002 },
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
    { dur: 60, title: '時代劇アワー',                 genre: 'drama' },
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
    { dur: 120, title: 'サスペンス劇場',              genre: 'drama' },
    { dur: 90, title: '歴史への招待状',               genre: 'doc'  },
    { dur: 60, title: '関口宏の一番新しい近現代史',     genre: 'doc'  },
    { dur: 60, title: 'サンデーニュース',             genre: 'news' },
    { dur: 60, title: 'BS-TBS 夕焼け劇場',            genre: 'drama' },
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

// TVDB fixture catalogue. Declared up here (above the schedule expander
// and the RANKINGS/ranking helpers that need it) so module load order
// never hits a temporal-dead-zone.
const TVDB_CATALOG_RAW = [
  { id: 10001, slug: 'darwin-ga-kita', type: 'series', title: 'ダーウィンが来た！', titleEn: 'Darwin has Come!',    network: 'NHK', year: 2006, matchedBy: 'exact', totalSeasons: 20, currentSeason: 20, currentEp: 5, totalEps: 824, status: 'continuing', poster: '' },
  { id: 10002, slug: 'nhk-special',    type: 'series', title: 'NHKスペシャル',     titleEn: 'NHK Special',          network: 'NHK', year: 1989, matchedBy: 'exact', totalSeasons: 37, currentSeason: 37, currentEp: 12, totalEps: 1082, status: 'continuing', poster: '' },
  { id: 10003, slug: 'itte-q',         type: 'series', title: '世界の果てまでイッテQ!', titleEn: "World's End Q",   network: 'NTV', year: 2007, matchedBy: 'exact', totalSeasons: 18, currentSeason: 18, currentEp: 30, totalEps: 612, status: 'continuing', poster: '' },
  { id: 10004, slug: 'hibike',         type: 'series', title: '響け！ユーフォニアム', titleEn: 'Sound! Euphonium',  network: 'NHK', year: 2015, matchedBy: 'exact', totalSeasons: 3,  currentSeason: 3,  currentEp: 8,  totalEps: 44,   status: 'continuing', poster: '' },
  { id: 20001, slug: 'anime-theatrical-2024', type: 'movie', title: '劇場版 名前のないアニメ', titleEn: 'The Unnamed Animation Film', network: 'Toho', year: 2024, matchedBy: 'exact', runtime: 118, director: '山田 太郎', rating: 8.2, poster: '' },
  { id: 20002, slug: 'hercule-poirot',  type: 'movie', title: '名探偵ポアロ ナイル殺人事件', titleEn: 'Death on the Nile', network: 'Fox', year: 2022, matchedBy: 'exact', runtime: 127, director: 'Kenneth Branagh', rating: 6.5, poster: '' },
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
    { title: 'NHKスペシャル',          channelName: 'NHK総合',    delta: 2,    tvdbId: 10002, quote: '巨大地震 最新研究' },
    { title: 'ダーウィンが来た！',     channelName: 'NHK総合',    delta: 1,    tvdbId: 10001, quote: '深海の巨大イカに迫る' },
    { title: '世界の果てまでイッテQ!', channelName: '日テレ',      delta: -2,   tvdbId: 10003, quote: 'みやぞん山籠り' },
    { title: '響け！ユーフォニアム',    channelName: 'TOKYO MX',   delta: null, tvdbId: 10004, quote: '第8話 それぞれの春' },
    { title: 'ブラタモリ',             channelName: 'NHK総合',    delta: -1,   tvdbId: null,  quote: null },
    { title: '連続テレビ小説',         channelName: 'NHK総合',    delta: 0,    tvdbId: null,  quote: '第58回' },
    { title: '金曜ドラマ',             channelName: 'TBS',        delta: 0,    tvdbId: null,  quote: '急転の第6話' },
    { title: '金曜プレミアム 劇場版アニメ', channelName: 'フジテレビ', delta: 3, tvdbId: 20001, quote: '金曜プレミアム枠' },
  ],
  drama: [
    { title: '金曜ドラマ',             channelName: 'TBS',        delta: 0,    tvdbId: null,  quote: '急転の第6話' },
    { title: '連続テレビ小説',         channelName: 'NHK総合',    delta: 1,    tvdbId: null,  quote: '第58回' },
    { title: '金曜ナイトドラマ',       channelName: 'テレビ朝日', delta: -1,   tvdbId: null,  quote: null },
    { title: '世にも奇妙な物語',       channelName: 'フジテレビ', delta: 2,    tvdbId: null,  quote: null },
    { title: '時代劇アワー',           channelName: 'BS日テレ',   delta: null, tvdbId: null,  quote: null },
    { title: 'サスペンス劇場',         channelName: 'BS-TBS',     delta: 0,    tvdbId: null,  quote: null },
  ],
  anime: [
    { title: '響け！ユーフォニアム',    channelName: 'TOKYO MX',   delta: 1,   tvdbId: 10004, quote: '第8話 それぞれの春' },
    { title: 'アニメイズム',           channelName: 'TOKYO MX',   delta: 0,   tvdbId: null,  quote: null },
    { title: 'ソードアートロード',     channelName: 'TOKYO MX',   delta: -1,  tvdbId: null,  quote: null },
    { title: '新作アニメ枠',           channelName: 'TOKYO MX',   delta: 2,   tvdbId: null,  quote: null },
    { title: 'テレ東系アニメ枠',       channelName: 'テレビ東京', delta: null, tvdbId: null, quote: null },
  ],
  doc: [
    { title: 'NHKスペシャル',          channelName: 'NHK総合',    delta: 1,    tvdbId: 10002, quote: null },
    { title: 'ダーウィンが来た！',     channelName: 'NHK総合',    delta: -1,   tvdbId: 10001, quote: null },
    { title: 'ドキュメント72時間',     channelName: 'NHK総合',    delta: 0,    tvdbId: null,  quote: null },
    { title: '情熱大陸',               channelName: 'TBS',        delta: 2,    tvdbId: null,  quote: null },
    { title: 'アナザーストーリーズ',    channelName: 'NHK BS',     delta: null, tvdbId: null, quote: null },
    { title: 'カンブリア宮殿',         channelName: 'テレビ東京', delta: 0,    tvdbId: null,  quote: null },
  ],
  movie: [
    { title: '金曜プレミアム 劇場版アニメ', channelName: 'フジテレビ', delta: 3, tvdbId: 20001, quote: null },
    { title: 'プレミアムシネマ',       channelName: 'NHK BSP4K',  delta: 1,   tvdbId: 20002, quote: '名探偵ポアロ' },
    { title: '金曜ロードショー',       channelName: '日テレ',      delta: 0,   tvdbId: null,  quote: null },
    { title: '特撮シネマ',             channelName: 'テレビ東京', delta: -2,  tvdbId: null,  quote: null },
    { title: '深夜の名作劇場',         channelName: 'BS-TBS',     delta: null, tvdbId: null, quote: null },
  ],
  var: [
    { title: '世界の果てまでイッテQ!', channelName: '日テレ',     delta: 1,    tvdbId: 10003, quote: null },
    { title: 'バリバラ',               channelName: 'NHK Eテレ',  delta: 2,    tvdbId: null,  quote: null },
    { title: 'プレバト！',              channelName: 'TBS',        delta: 0,    tvdbId: null,  quote: null },
    { title: '徹子の部屋',             channelName: 'テレビ朝日', delta: -1,   tvdbId: null,  quote: null },
    { title: 'アド街ック天国',         channelName: 'テレビ東京', delta: 0,    tvdbId: null,  quote: null },
  ],
  news: [
    { title: '報道ステーション',       channelName: 'テレビ朝日', delta: 0,    tvdbId: null, quote: null },
    { title: 'NEWS ZERO',              channelName: '日テレ',      delta: 1,   tvdbId: null, quote: null },
    { title: 'Nスタ',                  channelName: 'TBS',        delta: -1,   tvdbId: null, quote: null },
    { title: 'NHK ニュース7',           channelName: 'NHK総合',    delta: 0,   tvdbId: null, quote: null },
    { title: 'ワールドビジネスサテライト', channelName: 'テレビ東京', delta: 2, tvdbId: null, quote: null },
    { title: 'モーニングサテライト',    channelName: 'テレビ東京', delta: null, tvdbId: null, quote: null },
  ],
  edu: [
    { title: '100分 de 名著',            channelName: 'NHK Eテレ',  delta: 0,    tvdbId: null, quote: null },
    { title: 'サイエンスZERO',           channelName: 'NHK Eテレ',  delta: 1,    tvdbId: null, quote: null },
    { title: '先人たちの底力 知恵泉',     channelName: 'NHK Eテレ',  delta: -1,   tvdbId: null, quote: null },
  ],
  sport: [
    { title: 'MLB 中継',                channelName: 'NHK BS',     delta: 1,   tvdbId: null, quote: 'ヤンキース vs レッドソックス' },
    { title: '欧州サッカー ダイジェスト', channelName: 'NHK BS',     delta: 0,   tvdbId: null, quote: null },
    { title: 'サンデーラグビー',        channelName: 'BS日テレ',   delta: null, tvdbId: null, quote: null },
  ],
  music: [
    { title: 'クラシック音楽館',        channelName: 'NHK Eテレ',  delta: 0,   tvdbId: null, quote: 'N響定期演奏会' },
    { title: '名曲アルバム',            channelName: 'NHK BSP4K',  delta: 1,   tvdbId: null, quote: null },
    { title: 'アニソン倶楽部',          channelName: 'BS-TBS',     delta: -1,  tvdbId: null, quote: null },
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
