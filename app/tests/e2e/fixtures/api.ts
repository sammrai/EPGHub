import type { Page, Route } from '@playwright/test';

// -----------------------------------------------------------------------------
// Wire-format shapes — keep in lock-step with `app/src/api/epghub.gen.ts`.
// We duplicate the subset the tests exercise rather than importing the full
// OpenAPI file so this fixture stays self-contained.
// -----------------------------------------------------------------------------

export type BcType = 'GR' | 'BS' | 'CS';
export type Priority = 'high' | 'medium' | 'low';
export type Quality = '1080i' | '720p';
export type RecordingState =
  | 'scheduled'
  | 'recording'
  | 'encoding'
  | 'ready'
  | 'failed'
  | 'conflict';

export interface Channel {
  id: string;
  name: string;
  short: string;
  number: string;
  type: BcType;
  color: string;
  enabled: boolean;
  source: string;
}

export interface Genre {
  key: string;
  label: string;
  dot: string;
}

export type TvdbEntry =
  | {
      id: number;
      slug: string;
      title: string;
      titleEn: string;
      network: string;
      year: number;
      poster: string;
      matchedBy: string;
      type: 'series';
      totalSeasons: number;
      currentSeason: number;
      currentEp: number;
      totalEps: number;
      status: 'continuing' | 'ended';
    }
  | {
      id: number;
      slug: string;
      title: string;
      titleEn: string;
      network: string;
      year: number;
      poster: string;
      matchedBy: string;
      type: 'movie';
      runtime: number;
      director: string;
      rating: number;
    };

export interface Program {
  id: string;
  ch: string;
  startAt: string;
  endAt: string;
  title: string;
  genre: Genre;
  ep: string | null;
  series: string | null;
  hd?: boolean;
  desc?: string;
  tvdb?: TvdbEntry | null;
  tvdbSeason?: number | null;
  tvdbEpisode?: number | null;
  tvdbEpisodeName?: string | null;
}

export type RecordingSource =
  | { kind: 'once' }
  | { kind: 'rule'; ruleId: number }
  | { kind: 'series'; tvdbId: number };

export interface Recording {
  id: string;
  programId: string;
  ch: string;
  title: string;
  startAt: string;
  endAt: string;
  priority: Priority;
  quality: Quality;
  keepRaw: boolean;
  marginPre: number;
  marginPost: number;
  source: RecordingSource;
  state: RecordingState;
  allocatedTunerIdx?: number;
  recordedAt?: string | null;
  filename?: string | null;
  size?: number | null;
  duration?: number | null;
  thumb?: string | null;
  thumbGenerated?: boolean;
  protected?: boolean;
  new?: boolean;
  tvdbId?: number | null;
  series?: string | null;
  season?: number | null;
  ep?: number | null;
  epTitle?: string | null;
  ruleMatched?: string | null;
  encodeProgress?: number;
  encodePreset?: string | null;
  encodeError?: string | null;
  originalStartAt?: string | null;
  originalEndAt?: string | null;
  extendedBySec?: number;
}

export interface Rule {
  id: number;
  name: string;
  keyword: string;
  channels: string[];
  enabled: boolean;
  matches: number;
  nextMatch: { ch: string; title: string; at: string } | null;
  priority: Priority;
  quality: Quality;
  skipReruns: boolean;
  kind: 'keyword' | 'series';
  tvdb?: TvdbEntry;
  ngKeywords: string[];
  ngGenres: string[];
  ngChannels: string[];
  timeRangeDeny: Array<{ start: string; end: string }>;
  recentMatchLabel?: string | null;
}

export interface RankingItem {
  rank: number;
  title: string;
  channelName: string | null;
  delta: number | null;
  quote: string | null;
  nextProgramId?: string;
  tvdb: (TvdbEntry & { type: 'series' | 'movie' }) | null;
  syncedAt: string;
}

// -----------------------------------------------------------------------------
// Defaults — two channels, empty schedule by default. Tests seed programs
// through `state.programs.push(...)` or by passing them into `createMockApi`.
// -----------------------------------------------------------------------------

export const GENRE_DRAMA: Genre = { key: 'drama', label: 'ドラマ', dot: 'oklch(0.62 0.12 20)' };
export const GENRE_VAR: Genre = { key: 'var', label: 'バラエティ', dot: 'oklch(0.7 0.13 80)' };

export const defaultChannels = (): Channel[] => [
  { id: 'nhk-g', name: 'NHK総合', short: 'NHK G', number: '011', type: 'GR', color: 'oklch(0.55 0.12 28)', enabled: true, source: 'mirakurun' },
  { id: 'ex', name: 'テレビ朝日', short: 'EX', number: '051', type: 'GR', color: 'oklch(0.55 0.14 25)', enabled: true, source: 'mirakurun' },
];

// 現在の JST 放送日 (05:00 境界) を YYYY-MM-DD で返す。
// `jstTodayYmd` と揃えている — `new Date(Date.now() + 4h).UTC[Y-M-D]`。
// テストが実行された瞬間の放送日を計算し、その日の番組をモックで返す。
export function currentBroadcastDay(): string {
  const d = new Date(Date.now() + (9 - 5) * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function isoForJst(ymd: string, hhmm: string): string {
  return `${ymd}T${hhmm}:00+09:00`;
}

// ISO 同士の差 (分)
function diffMin(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

export function makeProgram(partial: Partial<Program> & { ch: string; startAt: string; endAt: string; title: string }): Program {
  // server の id 規則は `${ch}_${startAtISO}` なのでそれに合わせる。
  const id = partial.id ?? `${partial.ch}_${partial.startAt}`;
  return {
    id,
    ch: partial.ch,
    startAt: partial.startAt,
    endAt: partial.endAt,
    title: partial.title,
    genre: partial.genre ?? GENRE_DRAMA,
    ep: partial.ep ?? null,
    series: partial.series ?? null,
    hd: partial.hd ?? true,
    desc: partial.desc,
    tvdb: partial.tvdb ?? null,
    tvdbSeason: partial.tvdbSeason ?? null,
    tvdbEpisode: partial.tvdbEpisode ?? null,
    tvdbEpisodeName: partial.tvdbEpisodeName ?? null,
  };
}

export function tvdbSeries(overrides: Partial<Extract<TvdbEntry, { type: 'series' }>> = {}): TvdbEntry {
  return {
    type: 'series',
    id: 389042,
    slug: 'kaze-no-gunzo',
    title: '風の群像',
    titleEn: 'Kaze no Gunzo',
    network: 'NHK',
    year: 2026,
    poster: '',
    matchedBy: 'search',
    status: 'continuing',
    totalSeasons: 1,
    currentSeason: 1,
    currentEp: 16,
    totalEps: 48,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Mock API with mutable in-memory state. Each test should create a fresh
// instance via `const mock = createMockApi({...})` and then `await mock.install(page)`
// *before* navigating, so the first network request is intercepted.
// -----------------------------------------------------------------------------

export interface MockApiSeed {
  channels?: Channel[];
  programs?: Program[];
  recordings?: Recording[];
  rules?: Rule[];
  rankings?: RankingItem[];
}

export interface MockApi {
  state: {
    channels: Channel[];
    programs: Program[];
    recordings: Recording[];
    rules: Rule[];
    rankings: RankingItem[];
  };
  install: (page: Page) => Promise<void>;
  seedRecording: (rec: Partial<Recording> & { programId: string }) => Recording;
}

let recordingCounter = 0;
let ruleCounter = 0;

export function createMockApi(seed: MockApiSeed = {}): MockApi {
  const state = {
    channels: seed.channels ?? defaultChannels(),
    programs: seed.programs ?? [],
    recordings: seed.recordings ?? [],
    rules: seed.rules ?? [],
    rankings: seed.rankings ?? [],
  };

  function nextRecordingId(): string {
    recordingCounter += 1;
    return `rec_mock_${recordingCounter.toString(36)}_${Date.now()}`;
  }
  function nextRuleId(): number {
    ruleCounter += 1;
    return 1000 + ruleCounter;
  }

  function programById(programId: string): Program | undefined {
    return state.programs.find((p) => p.id === programId);
  }

  function seedRecording(partial: Partial<Recording> & { programId: string }): Recording {
    const prog = programById(partial.programId);
    const rec: Recording = {
      id: partial.id ?? nextRecordingId(),
      programId: partial.programId,
      ch: partial.ch ?? prog?.ch ?? 'nhk-g',
      title: partial.title ?? prog?.title ?? '',
      startAt: partial.startAt ?? prog?.startAt ?? new Date().toISOString(),
      endAt: partial.endAt ?? prog?.endAt ?? new Date().toISOString(),
      priority: partial.priority ?? 'medium',
      quality: partial.quality ?? '1080i',
      keepRaw: partial.keepRaw ?? false,
      marginPre: partial.marginPre ?? 0,
      marginPost: partial.marginPost ?? 30,
      source: partial.source ?? { kind: 'once' },
      state: partial.state ?? 'scheduled',
      thumbGenerated: partial.thumbGenerated ?? false,
      protected: partial.protected ?? false,
      new: partial.new ?? false,
      extendedBySec: partial.extendedBySec ?? 0,
    };
    state.recordings.push(rec);
    return rec;
  }

  async function install(page: Page): Promise<void> {
    // glob `**/api/**` は `/src/api/epghub.ts` 等の Vite 配信まで飲み込むので
    // 述語で pathname が `/api/` で始まるときだけマッチさせる。
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route: Route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/api/, '');
      const method = route.request().method();
      const bodyText = route.request().postData();
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined;

      // --- channels ---
      if (path === '/channels' && method === 'GET') {
        return route.fulfill({ json: state.channels });
      }

      // --- schedule ---
      if (path === '/schedule' && method === 'GET') {
        const date = url.searchParams.get('date');
        const filtered = date
          ? state.programs.filter((p) => broadcastDay(p.startAt) === date)
          : state.programs;
        return route.fulfill({ json: filtered });
      }

      // --- recordings ---
      if (path === '/recordings' && method === 'GET') {
        const stateFilter = url.searchParams.get('state');
        const allowed = stateFilter ? new Set(stateFilter.split(',')) : null;
        const list = allowed
          ? state.recordings.filter((r) => allowed.has(r.state))
          : state.recordings;
        return route.fulfill({ json: list });
      }
      if (path === '/recordings' && method === 'POST') {
        const b = body as { programId: string; priority?: Priority; quality?: Quality; keepRaw?: boolean; marginPre?: number; marginPost?: number; source?: RecordingSource; force?: boolean };
        const created = seedRecording({
          programId: b.programId,
          priority: b.priority,
          quality: b.quality,
          keepRaw: b.keepRaw,
          marginPre: b.marginPre,
          marginPost: b.marginPost,
          source: b.source,
          state: 'scheduled',
        });
        return route.fulfill({ status: 201, json: created });
      }
      const recMatch = path.match(/^\/recordings\/([^/]+)$/);
      if (recMatch) {
        const id = decodeURIComponent(recMatch[1]);
        const idx = state.recordings.findIndex((r) => r.id === id);
        if (method === 'GET') {
          if (idx < 0) return route.fulfill({ status: 404, json: { message: 'not found' } });
          return route.fulfill({ json: state.recordings[idx] });
        }
        if (method === 'DELETE') {
          if (idx >= 0) state.recordings.splice(idx, 1);
          return route.fulfill({ status: 204, body: '' });
        }
        if (method === 'PATCH') {
          if (idx < 0) return route.fulfill({ status: 404, json: { message: 'not found' } });
          state.recordings[idx] = { ...state.recordings[idx], ...(body as Partial<Recording>) };
          return route.fulfill({ json: state.recordings[idx] });
        }
      }
      if (path.match(/^\/recordings\/[^/]+\/stop$/) && method === 'POST') {
        return route.fulfill({ status: 204, body: '' });
      }

      // --- rules ---
      if (path === '/rules' && method === 'GET') {
        return route.fulfill({ json: state.rules });
      }
      if (path === '/rules' && method === 'POST') {
        const b = body as Partial<Rule> & { name: string; keyword: string; kind?: 'keyword' | 'series' };
        const rule: Rule = {
          id: nextRuleId(),
          name: b.name,
          keyword: b.keyword,
          channels: b.channels ?? [],
          enabled: b.enabled ?? true,
          matches: 0,
          nextMatch: null,
          priority: b.priority ?? 'medium',
          quality: b.quality ?? '1080i',
          skipReruns: b.skipReruns ?? true,
          kind: b.kind ?? 'keyword',
          tvdb: b.tvdb,
          ngKeywords: b.ngKeywords ?? [],
          ngGenres: b.ngGenres ?? [],
          ngChannels: b.ngChannels ?? [],
          timeRangeDeny: b.timeRangeDeny ?? [],
        };
        state.rules.push(rule);
        return route.fulfill({ status: 201, json: rule });
      }
      const ruleMatch = path.match(/^\/rules\/(\d+)$/);
      if (ruleMatch) {
        const id = Number(ruleMatch[1]);
        const idx = state.rules.findIndex((r) => r.id === id);
        if (method === 'PATCH') {
          if (idx < 0) return route.fulfill({ status: 404, json: { message: 'not found' } });
          state.rules[idx] = { ...state.rules[idx], ...(body as Partial<Rule>) };
          return route.fulfill({ json: state.rules[idx] });
        }
        if (method === 'DELETE') {
          if (idx >= 0) state.rules.splice(idx, 1);
          return route.fulfill({ status: 204, body: '' });
        }
      }

      // --- tuners / now-recording ---
      if (path === '/tuners' && method === 'GET') {
        return route.fulfill({
          json: [
            { type: 'GR', total: 2, inUse: 0 },
            { type: 'BS', total: 2, inUse: 0 },
            { type: 'CS', total: 1, inUse: 0 },
          ],
        });
      }
      if (path === '/now-recording' && method === 'GET') {
        return route.fulfill({ json: [] });
      }

      // --- system ---
      if (path === '/system' && method === 'GET') {
        return route.fulfill({
          json: {
            storage: { totalBytes: 2_000_000_000_000, usedBytes: 500_000_000_000 },
            upcomingReserves: state.recordings.filter((r) => r.state === 'scheduled').length,
            today: currentBroadcastDay(),
            version: 'test',
          },
        });
      }

      // --- rankings (Discover) ---
      if (path === '/rankings' && method === 'GET') {
        const genre = (url.searchParams.get('genre') ?? 'all') as string;
        return route.fulfill({ json: { genre, items: state.rankings } });
      }

      // --- tvdb (Modal lazy lookups + catalog) ---
      if (path === '/tvdb' && method === 'GET') {
        // useTvdbCatalog が読む Record<string, TvdbEntry>
        return route.fulfill({ json: {} });
      }
      if (path.startsWith('/tvdb/search') && method === 'GET') {
        return route.fulfill({ json: [] });
      }
      if (path.match(/^\/tvdb\/\d+$/) && method === 'GET') {
        return route.fulfill({ json: null });
      }
      if (path.match(/^\/tvdb\/\d+\/episodes$/) && method === 'GET') {
        return route.fulfill({ json: [] });
      }

      // --- programs (deep link might ask for one) ---
      const progMatch = path.match(/^\/programs\/(.+)$/);
      if (progMatch && method === 'GET') {
        const id = decodeURIComponent(progMatch[1]);
        const prog = programById(id);
        if (!prog) return route.fulfill({ status: 404, json: { message: 'not found' } });
        return route.fulfill({ json: prog });
      }

      // --- fallthrough: 404 with a warning in the response so failures surface ---
      return route.fulfill({
        status: 404,
        json: { message: `mock: unhandled ${method} ${path}` },
      });
    });
  }

  return { state, install, seedRecording };
}

// `startAt` の ISO から JST 放送日 (05:00 境界) を YYYY-MM-DD で返す。
// `server/` の `programs.id` 生成ロジックと対応する。04:59 までは前日扱い。
function broadcastDay(iso: string): string {
  const ms = Date.parse(iso);
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  const shifted = new Date(jst.getTime() - 5 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}
