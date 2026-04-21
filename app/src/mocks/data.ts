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
  ApiTunerAllocation,
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

interface Slot {
  offsetMin: number;
  durationMin: number;
  ch: string;
  title: string;
  series?: string;
  genre: keyof typeof GENRES;
  ep?: string;
  desc?: string;
}

const TEMPLATE: Slot[] = [
  { offsetMin: 60,  durationMin: 30,  ch: 'nhk-g', title: 'NHK ニュースおはよう日本', genre: 'news' },
  { offsetMin: 90,  durationMin: 45,  ch: 'nhk-g', title: '連続テレビ小説', series: 'asadora', ep: '#58', genre: 'drama' },
  { offsetMin: 540, durationMin: 60,  ch: 'nhk-g', title: 'ダーウィンが来た！', series: 'darwin', ep: '#824', genre: 'doc', desc: '深海の巨大イカに迫る。' },
  { offsetMin: 780, durationMin: 55,  ch: 'nhk-g', title: 'NHK スペシャル', series: 'nhk-special', ep: '#1082', genre: 'doc', desc: '巨大地震 最新研究。' },
  { offsetMin: 120, durationMin: 90,  ch: 'nhk-e', title: 'こどもアニメ劇場', genre: 'anime' },
  { offsetMin: 600, durationMin: 30,  ch: 'nhk-e', title: '100分 de 名著', genre: 'edu' },
  { offsetMin: 480, durationMin: 120, ch: 'ntv',   title: 'ZIP！', genre: 'news' },
  { offsetMin: 720, durationMin: 60,  ch: 'ntv',   title: '世界の果てまでイッテQ!', series: 'itteq', ep: '#612', genre: 'var' },
  { offsetMin: 420, durationMin: 90,  ch: 'ex',    title: 'グッド！モーニング', genre: 'news' },
  { offsetMin: 780, durationMin: 60,  ch: 'ex',    title: '報道ステーション', genre: 'news' },
  { offsetMin: 360, durationMin: 60,  ch: 'tbs',   title: 'THE TIME,', genre: 'news' },
  { offsetMin: 840, durationMin: 120, ch: 'tbs',   title: '金曜ドラマ', series: 'nichigeki-2026q2', ep: '#6', genre: 'drama' },
  { offsetMin: 300, durationMin: 180, ch: 'tx',    title: 'モーニングサテライト', genre: 'news' },
  { offsetMin: 660, durationMin: 60,  ch: 'tx',    title: 'アド街ック天国', genre: 'var' },
  { offsetMin: 420, durationMin: 150, ch: 'cx',    title: 'めざましテレビ', genre: 'news' },
  { offsetMin: 780, durationMin: 60,  ch: 'cx',    title: '金曜プレミアム', ep: '#金ロー', genre: 'movie' },
  { offsetMin: 480, durationMin: 30,  ch: 'mx',    title: 'TOKYO MX NEWS', genre: 'news' },
  { offsetMin: 720, durationMin: 30,  ch: 'mx',    title: 'アニメイズム', series: 'euph-2026', ep: '#8', genre: 'anime' },
  { offsetMin: 900, durationMin: 30,  ch: 'mx',    title: 'ソードアートロード', series: 'kaiju8', ep: '#10', genre: 'anime' },
];

export function programsForDate(ymd: string): ApiProgram[] {
  const base = jstBroadcastStart(ymd).getTime();
  return TEMPLATE.map((s) => {
    const startAt = new Date(base + s.offsetMin * 60_000).toISOString();
    const endAt = new Date(base + (s.offsetMin + s.durationMin) * 60_000).toISOString();
    return {
      id: `${s.ch}_${startAt}`,
      ch: s.ch,
      title: s.title,
      startAt,
      endAt,
      ep: s.ep ?? null,
      series: s.series ?? null,
      desc: s.desc,
      genre: GENRES[s.genre] ?? GENRES.other,
      hd: true,
    };
  }) as unknown as ApiProgram[];
}

function makeRecordings(today: string): ApiRecording[] {
  const progs = programsForDate(today) as unknown as Array<{ id: string; ch: string; title: string; startAt: string; endAt: string; series?: string | null }>;
  const picks = progs.filter((p) => ['darwin', 'nhk-special', 'itteq', 'euph-2026', 'nichigeki-2026q2'].includes(String(p.series)));
  const states = ['scheduled', 'recording', 'ready', 'ready', 'scheduled'];
  return picks.map((p, i) => ({
    id: `rec-${i + 1}`,
    programId: p.id,
    ch: p.ch,
    title: p.title,
    startAt: p.startAt,
    endAt: p.endAt,
    priority: i === 0 ? 'high' : 'medium',
    quality: '1080i',
    keepRaw: false,
    marginPre: 0,
    marginPost: 30,
    state: states[i] ?? 'scheduled',
    source: { kind: 'once' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })) as unknown as ApiRecording[];
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

export const TUNER_ALLOCATION = { slots: [] } as unknown as ApiTunerAllocation;

export function nowRecording(today: string): ApiNowRecording[] {
  const progs = programsForDate(today) as unknown as Array<{ id: string; ch: string; title: string; startAt: string; endAt: string; series?: string | null }>;
  const hit = progs.find((p) => p.series === 'darwin');
  if (!hit) return [];
  return [{
    id: `nr-${hit.id}`,
    programId: hit.id,
    title: hit.title,
    ch: hit.ch,
    startAt: hit.startAt,
    endAt: hit.endAt,
  }] as unknown as ApiNowRecording[];
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

export const RANKINGS = {
  genre: 'all',
  items: [
    { rank: 1, title: 'NHKスペシャル',          channelName: 'NHK総合',   delta: 2,    tvdb: null, quote: null, syncedAt: new Date().toISOString() },
    { rank: 2, title: 'ブラタモリ',             channelName: 'NHK総合',   delta: -1,   tvdb: null, quote: null, syncedAt: new Date().toISOString() },
    { rank: 3, title: '連続テレビ小説',         channelName: 'NHK総合',   delta: 0,    tvdb: null, quote: null, syncedAt: new Date().toISOString() },
    { rank: 4, title: 'ダーウィンが来た！',     channelName: 'NHK総合',   delta: 1,    tvdb: null, quote: null, syncedAt: new Date().toISOString() },
    { rank: 5, title: '世界の果てまでイッテQ!', channelName: '日テレ',    delta: -2,   tvdb: null, quote: null, syncedAt: new Date().toISOString() },
    { rank: 6, title: '金曜ドラマ',             channelName: 'TBS',       delta: 0,    tvdb: null, quote: null, syncedAt: new Date().toISOString() },
    { rank: 7, title: '金曜プレミアム',         channelName: 'フジテレビ', delta: 3,   tvdb: null, quote: null, syncedAt: new Date().toISOString() },
    { rank: 8, title: 'アニメイズム',           channelName: 'TOKYO MX',  delta: null, tvdb: null, quote: null, syncedAt: new Date().toISOString() },
  ],
} as unknown as ApiRankingList;

export const TVDB_CATALOG = [
  { id: 10001, slug: 'darwin-ga-kita', type: 'series', title: 'ダーウィンが来た！', titleEn: 'Darwin has Come!', network: 'NHK', year: 2006, matchedBy: 'exact', totalSeasons: 20, currentSeason: 20, currentEp: 5, totalEps: 824, status: 'continuing', poster: '' },
  { id: 10002, slug: 'nhk-special',    type: 'series', title: 'NHKスペシャル',     titleEn: 'NHK Special',       network: 'NHK', year: 1989, matchedBy: 'exact', totalSeasons: 37, currentSeason: 37, currentEp: 12, totalEps: 1082, status: 'continuing', poster: '' },
  { id: 10003, slug: 'itte-q',         type: 'series', title: '世界の果てまでイッテQ!', titleEn: "World's End Q",     network: 'NTV', year: 2007, matchedBy: 'exact', totalSeasons: 18, currentSeason: 18, currentEp: 30, totalEps: 612, status: 'continuing', poster: '' },
  { id: 10004, slug: 'hibike',         type: 'series', title: '響け！ユーフォニアム', titleEn: 'Sound! Euphonium',   network: 'NHK', year: 2015, matchedBy: 'exact', totalSeasons: 3,  currentSeason: 3,  currentEp: 8,  totalEps: 44,   status: 'continuing', poster: '' },
] as unknown as ApiTvdbEntry[];

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
