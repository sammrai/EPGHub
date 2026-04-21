import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Program } from '../schemas/program.ts';
import type { TvdbEntry } from '../schemas/tvdb.ts';
import { db } from '../db/client.ts';
import { programs, titleOverrides, tvdbEntries } from '../db/schema.ts';
import { tvdbService } from './tvdbService.ts';
import { tvdbRowToEntry } from './ruleService.ts';

// -----------------------------------------------------------------
// Title normalization — unchanged from the in-memory version. EPG titles are
// noisy (closed-caption markers, rerun flags, season/episode numbers, zenkaku
// digits, chapter prefixes). We need the canonical show name before TVDB
// search can reliably find a match.
// -----------------------------------------------------------------

const ZENKAKU_DIGIT_OFFSET = '０'.charCodeAt(0) - '0'.charCodeAt(0);
const ZENKAKU_ASCII_OFFSET = 'Ａ'.charCodeAt(0) - 'A'.charCodeAt(0);

// Fullwidth → ASCII for digits and Latin letters. We preserve the
// ideographic space `　` as-is (it's later used as a soft-cut marker) and we
// fold fullwidth punctuation (`！`, `？`, `＃`) to ASCII so subsequent
// regexes don't need dual branches.
function zenkakuToHankaku(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - ZENKAKU_DIGIT_OFFSET))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - ZENKAKU_ASCII_OFFSET))
    .replace(/＃/g, '#')
    .replace(/！/g, '!')
    .replace(/？/g, '?');
}

// Square-style bracket markers: both broadcaster codes like `[字][解][デ][再]`
// and long episode subtitles inside `【...】` / `〔...〕` / `［...］`. The
// negated-class ensures a single match can't span past the next closer, so
// consecutive `[字][解]` runs get stripped one at a time on repeated passes.
const BRACKET_MARKERS_RE = /[\[［【〔][^\]］】〕]*[\]］】〕]/g;

// `＜...＞` / `<...>` angle-bracket tags: category labels (`＜アニメギルド＞`,
// `＜BS土曜プレミアム＞`), caption flags (`＜字幕スーパー＞`), crosstalk tags
// (`＜天竺川原×真空川北＞`), and reading glosses (`牙狼＜GARO＞`). Always meta.
const ANGLE_TAG_RE = /[＜<][^＞>]*[＞>]/g;

// Parenthesised meta tokens — rerun / caption / total-episode / weekday /
// year-bracket / edition-number / (秘). We enumerate shapes explicitly so we
// don't strip genuine parens like `（チュモン）` that are part of titles.
const PAREN_META_RE =
  /\s*[（(](?:\s*(?:秘|再|新|字|字幕|字幕スーパー|日本語字幕|吹替|吹替版|映画|全\s*\d+\s*[話回]|第\s*\d+\s*[話回夜]?|\d+|\d+\s*\/\s*\d+|\d{4}年[^)）]*|月|火|水|木|金|土|日|前編|後編|中編|完結編|最終回|総集編)\s*)[)）]\s*/g;

// `(秘)` appearing without whitespace at the start — trimmed separately so
// we don't accidentally chop a surrounding kana character.
const MARUHI_RE = /[（(]\s*秘\s*[)）]/g;

// Sharp-style episode number markers: `#4`, `# 12`, and also the standalone
// `No.12` / `♯4` variants occasionally seen.
const HASH_EP_RE = /\s*[#♯]\s*\d+\s*/g;

// Season / arc markers. These are replaced with a space (never an empty
// string) so adjacent tokens don't glue together. Because most of these
// markers introduce a never-meaningful tail (an episode number is almost
// always followed by the episode's subtitle), we also wipe out everything
// that FOLLOWS the first such marker.
//
// This is the primary "cut point" of the normalizer: once the normalizer
// sees `第N話`, `Season2`, or `#4`, everything after is treated as
// episode-specific metadata. No `\b` because `期/話/回/etc.` aren't word
// characters in JS regex.
const CUT_AT_SEASON_RE =
  /[\s　]*(?:\d+(?:st|nd|rd|th)\s*[Ss]eason|[Ss]eason\s*\d+|シーズン\s*\d+|第\s*[0-9一二三四五六七八九十百千]+\s*(?:期|シリーズ|部|話|回|夜|局|クール|週)|[#♯]\s*\d+|\d+\s*回戦).*$/;

// Also cut a naked "N話" or "N回" when preceded by whitespace — used for
// `４話　本厚木のバーニャカウダ` where the 第 prefix is dropped.
const CUT_AT_BARE_EP_RE = /[\s　]+\d+\s*[話回](?:[\s　].*|\s*$)/;

// Cut at the first arrow marker (▼/▽/★/◆). These are hard separators for
// the episode-of-the-week blurb.
const CUT_AT_ARROW_RE = /[▼▽★◆].*$/;

// Trailing markers that describe the episode, not the show. Strip at end
// of the (trimmed) title. Guarded suffixes (those that also appear inside
// a real show title) are applied by `stripSuffixes()` below.
const STRIP_SUFFIX_RE: RegExp[] = [
  /[\s　]*(?:特別編|特集|完結編|総集編|傑作選|名場面(?:集)?|再放送|ダイジェスト(?:版)?|BS傑作選|土曜ダイジェスト版)[\s　]*$/,
  /[\s　]*(?:最終回|SP|スペシャル)[\s　]*$/,
  /[\s　]*(?:前編|後編|中編)[\s　]*$/,
  /[\s　]*全\s*\d+\s*[話回][\s　]*$/,
  /[\s　]*第\s*\d+\s*回[\s　]*$/,
  // Trailing episode number like "トムとジェリー 13" or "商道－サンド－ 79"
  // — require at least one whitespace before to avoid chopping "ハチ公20".
  /[\s　]+\d+[\s　]*$/,
  // Trailing "N/M" fraction like "3/10".
  /[\s　]*\(?[\s　]*\d+\s*\/\s*\d+[\s　]*\)?[\s　]*$/,
];

// Trailing separator — only applied when there's no matching opener
// somewhere earlier in the string. `牙狼 -魔戒ノ花-` has a paired pair
// of `-` so we keep both; `Show・` has an orphan `・` to strip.
const TRAILING_SEP_RE = /[\s　]+[・\-–—][\s　]*$/;

// Known block/genre prefixes. Order matters: longer / more specific first so
// `韓国時代劇` wins over `時代劇`, `連続テレビ小説` over `ドラマ`. Each is
// matched only when it appears at the start of the working string.
const BLOCK_PREFIXES = [
  '連続テレビ小説',
  '大河ドラマ',
  '韓国時代劇',
  '中国時代劇',
  '時代劇スペシャル',
  '時代劇',
  'TVアニメ',
  'ザ・ミステリー',
  '水曜アニメ',
  '金曜ミステリー',
  'アニメ',
  'ドラマ\\d+',
  'ドラマ',
  'シネマ',
  '映画',
  '\\d+時のアニメ',
];
const BLOCK_PREFIX_RE = new RegExp(
  `^(?:${BLOCK_PREFIXES.join('|')})[\\s　]+`
);

// Hosts where a quoted inner ( `「…」` / `『…』` ) is the actual show name —
// but only when the prefix is IMMEDIATELY followed by the opening quote
// (optionally whitespace between). This distinguishes `大河ドラマ「風の群像」`
// from `アニメ　おじゃる丸「小町とオカメ」` where `小町とオカメ` is a chapter.
const QUOTED_HOST_PREFIX_RE = new RegExp(
  `^(?:${BLOCK_PREFIXES.concat([
    '日曜劇場',
    '金曜ロードショー',
    'NHKスペシャル',
    '時代劇スペシャル',
    '橋田壽賀子ドラマ',
  ]).join('|')})[\\s　]*[「『]`
);

/**
 * Return the innermost `「...」` or `『...』` quoted segment in `title` that
 * contains no nested opening quote (i.e. the deepest quoted unit). Returns
 * null when no non-empty quoted segment is present. Prefers `『』`, which is
 * conventionally reserved for show-title quoting.
 */
function extractQuoted(title: string): string | null {
  const hard = title.match(/『([^『』]+)』/);
  if (hard && hard[1].trim()) return hard[1].trim();
  const soft = title.match(/「([^「」]+)」/);
  if (soft && soft[1].trim()) return soft[1].trim();
  return null;
}

/**
 * True when the string starts with a quoted fragment (possibly followed by
 * episode metadata): `『BEYBLADE X』オンエア争奪バトル！` or `「風の群像」第16回`.
 * Lets us extract the quoted segment as the show title without confusing it
 * with a quoted episode subtitle in the middle of a longer title.
 */
function leadsWithQuoted(s: string): boolean {
  return /^[\s　]*[「『][^「」『』]+[」』]/.test(s);
}

/**
 * Drop everything after the first whitespace whose tail contains both
 * Japanese kana/kanji and an exclamation/question punctuation. Handles
 * `ShowName<wide-space>episode promo!`. Does NOT fire when the tail is
 * purely ASCII (English show names like `BanG Dream! It's MyGO!!!!!`).
 */
function stripPromoTail(s: string): string {
  const ws = s.match(/[\s　]/);
  if (!ws) return s;
  const tail = s.slice(ws.index!);
  if (!/[\u3040-\u30FF\u4E00-\u9FFF]/.test(tail)) return s;
  if (!/[!?]/.test(tail)) return s;
  return s.slice(0, ws.index!);
}

/**
 * Strip a trailing single dash / bullet unless there's a matching opener
 * earlier in the string, which would indicate a balanced `- subtitle -`
 * wrap (common in anime arc names).
 */
function stripOrphanTrailingSep(s: string): string {
  const m = s.match(TRAILING_SEP_RE);
  if (!m) return s;
  const ch = m[0].trim()[0];
  const head = s.slice(0, m.index!);
  // If the same separator already appears elsewhere, it's probably balanced.
  if (head.includes(ch)) return s;
  return s.replace(TRAILING_SEP_RE, '');
}

/**
 * Strip the leading `第N回` edition marker (common for broadcast
 * tournaments like `第74回 NHK杯テレビ囲碁トーナメント`). Only fires when
 * `第N回` is at the very start — internal `第N回` (episode indices) is
 * handled by CUT_AT_SEASON_RE.
 */
const LEADING_EDITION_RE = /^[\s　]*第\s*[0-9一二三四五六七八九十百千]+\s*回[\s　]*/;

export function normalizeTitle(raw: string): string {
  if (!raw) return '';

  // 1. Fullwidth → ASCII (digits/letters/common punctuation). We keep `　`
  //    so we can still use it as a soft cut.
  let t = zenkakuToHankaku(raw);
  let prev: string;

  // 2. Strip bracketed markers (`[...]`, `【...】`, `〔...〕`, `［...］`).
  //    Iterate because a bracket's inner content occasionally looks like a
  //    second marker after the outer closer is removed.
  //    Remember the stripped bracket content for fallback — if later
  //    passes leave us with an empty string, that content was all we had.
  let bracketFallback = '';
  const bracketMatch = t.match(BRACKET_MARKERS_RE);
  if (bracketMatch && bracketMatch.length === 1) {
    // Extract inner for the single-bracket-only case (`【動物】`).
    // Single-character CJK markers like `字`/`解`/`再` are broadcaster flags,
    // not titles — skip them. We require >=2 characters to treat as fallback.
    const inner = bracketMatch[0].slice(1, -1).trim();
    if (inner.length >= 2) bracketFallback = inner;
  }
  do {
    prev = t;
    t = t.replace(BRACKET_MARKERS_RE, ' ');
  } while (t !== prev);

  // 3. Strip `＜...＞` angle tags unconditionally.
  t = t.replace(ANGLE_TAG_RE, ' ');

  // 4. Strip (秘) + parenthesised meta tokens.
  t = t.replace(MARUHI_RE, ' ');
  t = t.replace(PAREN_META_RE, ' ');

  // 5. Hard cut at arrow markers (▼/▽/★/◆). These introduce the weekly
  //    episode description, and anything — including quoted setlists —
  //    after them is unusable as a show title.
  t = t.replace(CUT_AT_ARROW_RE, ' ');

  // 6. Drop leading edition number like `第74回 NHK杯…`.
  t = t.replace(LEADING_EDITION_RE, '');

  // 7. If the current working string has a genre/block prefix followed by
  //    a quoted inner title (`大河ドラマ「豊臣兄弟！」…`), prefer the quoted
  //    inner. This also handles `『Re:ゼロ…』` after an `アニメ　` prefix.
  //    The QUOTED_HOST_PREFIX_RE requires the quote IMMEDIATELY after the
  //    prefix (whitespace OK); otherwise we'd strip real show names like
  //    `おじゃる丸` out of `アニメ　おじゃる丸「小町とオカメ」`.
  const leading = t.trimStart();
  if (QUOTED_HOST_PREFIX_RE.test(leading)) {
    const afterPrefix = leading.replace(BLOCK_PREFIX_RE, '');
    const inner = extractQuoted(afterPrefix) ?? extractQuoted(leading);
    if (inner) t = inner;
  } else if (leadsWithQuoted(t)) {
    const inner = extractQuoted(t);
    if (inner) t = inner;
  } else {
    // Otherwise, drop any quoted segments — they're almost always chapter
    // or episode subtitles, not show names. Do this twice to clean up
    // `「「nested」…」` setlists: outer quote may still contain `「` after
    // inner strips.
    for (let i = 0; i < 2; i++) {
      t = t.replace(/[\s　]*[「『][^「」『』]*[」』][\s　]*/g, ' ');
    }
    // Any left-over opening quote (unbalanced after setlist teardown) is
    // noise — drop it along with whatever is left after it.
    t = t.replace(/[\s　]*[「『].*$/, '');
  }

  // 8. Strip leading block prefix (fixed-point so stacked prefixes like
  //    `[新]ドラマ` compose correctly after step 2 removed the `[新]`).
  do {
    prev = t;
    t = t.trimStart().replace(BLOCK_PREFIX_RE, '');
  } while (t !== prev);

  // 9. Hard cut at the first season / episode / arc marker. Everything
  //    from the marker onwards is weekly-episode metadata.
  t = t.replace(CUT_AT_SEASON_RE, ' ');
  t = t.replace(CUT_AT_BARE_EP_RE, ' ');

  // 10. Trailing suffix strip (前編/後編/SP/最終回/bare trailing number…).
  //     Run to fixed point so `ダイジェスト版 第3週` comes off in order.
  do {
    prev = t;
    for (const re of STRIP_SUFFIX_RE) t = t.replace(re, '');
    t = stripOrphanTrailingSep(t);
    t = t.replace(/[\s　]+$/, '');
  } while (t !== prev);

  // 11. Promo-tail cut: drop whitespace + Japanese blurb containing `!`/`?`.
  t = stripPromoTail(t);

  // 12. Collapse whitespace runs to a single ASCII space, trim.
  t = t.replace(/[\s　]+/g, ' ').trim();
  // Strip orphan leading punctuation (e.g. `・Show name`).
  t = t.replace(/^[・,、。／\/]\s*/, '');
  // Strip orphan trailing comma / bullet / slash (dashes handled earlier
  // to preserve balanced `-subtitle-` wraps).
  t = t.replace(/\s*[・,、／\/]$/, '').trim();

  // 13. Fallback: if everything got stripped but the title was effectively
  //     just a bracketed chapter name like `【動物】`, use that.
  if (!t && bracketFallback) t = bracketFallback;

  return t;
}

// -----------------------------------------------------------------
// Generic titles — these phrase matches are banned from TVDB results
// because they produce false positives (e.g. 'ニュース' → 'ニュースの女').
// Rule/manual match can still link these titles explicitly.
// -----------------------------------------------------------------

const GENERIC_TITLES: ReadonlySet<string> = new Set([
  'ニュース', '天気予報', '気象情報', 'NHKニュース', 'ミニ番組',
  'お知らせ', '天気', 'スポーツ', 'フィラー', '番組宣伝',
  'お天気', 'データ放送', 'テレビショッピング', 'TVショッピング',
]);

const MAX_CONCURRENT = 4;
const NEW_TITLES_PER_FETCH = 120;
const AUTO_REMATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // auto rows re-resolve after 30d

class PromisePool {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// -----------------------------------------------------------------
// Scoring — same ranking as before. Exact > titleEn exact > tight startsWith
// > tight substring. Loose matches are rejected.
// -----------------------------------------------------------------

function scoreOf(e: TvdbEntry, key: string): number {
  const ja = (e.title ?? '').trim();
  const en = (e.titleEn ?? '').trim();
  const kLower = key.toLowerCase();
  if (ja === key || en === key) return 1000;
  if (en.toLowerCase() === kLower) return 950;
  const jaLenRatio = ja.length / Math.max(1, key.length);
  const enLenRatio = en.length / Math.max(1, key.length);
  if (jaLenRatio <= 1.4 && ja.startsWith(key)) return 700 - ja.length;
  if (enLenRatio <= 1.4 && en.toLowerCase().startsWith(kLower)) return 680 - en.length;
  if (jaLenRatio <= 1.6 && ja.includes(key)) return 500 - ja.length;
  if (key.length >= 4 && (key.includes(ja) || key.toLowerCase().includes(en.toLowerCase())))
    return 300;
  return 0;
}

function pickBest(
  results: TvdbEntry[],
  key: string,
  opts?: { allowMovie?: boolean },
): TvdbEntry | null {
  // When the EPG group has no program tagged with ARIB genre "映画", exclude
  // movie-type TVDB candidates entirely. Broadcaster genre is the strongest
  // signal we have, and scoring-by-title alone routinely misclassifies a TV
  // show as a same-named film (e.g. an anime series that shares a title with
  // a theatrical film gets the film's metadata attached). When the group
  // *does* contain a movie-flagged airing, fall back to the plain score so
  // both candidate types compete.
  const allowMovie = opts?.allowMovie ?? true;
  const pool = allowMovie ? results : results.filter((e) => e.type !== 'movie');
  const ranked = pool
    .map((e) => ({ e, s: scoreOf(e, key) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s);
  return ranked[0]?.e ?? null;
}

// -----------------------------------------------------------------
// DB helpers
// -----------------------------------------------------------------

type OverrideRow = typeof titleOverrides.$inferSelect;

async function loadOverrides(): Promise<Map<string, OverrideRow>> {
  const rows = await db.select().from(titleOverrides);
  const map = new Map<string, OverrideRow>();
  for (const r of rows) map.set(r.normalizedTitle, r);
  return map;
}

async function upsertTvdbEntry(
  entry: TvdbEntry,
  episodes?: Array<{ s: number; e: number; aired?: string; name?: string }>
): Promise<void> {
  const base = {
    tvdbId: entry.id,
    slug: entry.slug,
    kind: entry.type,
    title: entry.title,
    titleEn: entry.titleEn,
    network: entry.network,
    year: entry.year,
    poster: entry.poster,
    matchedBy: entry.matchedBy,
    totalSeasons: entry.type === 'series' ? entry.totalSeasons : null,
    currentSeason: entry.type === 'series' ? entry.currentSeason : null,
    currentEp: entry.type === 'series' ? entry.currentEp : null,
    totalEps: entry.type === 'series' ? entry.totalEps : null,
    status: entry.type === 'series' ? entry.status : null,
    runtime: entry.type === 'movie' ? entry.runtime : null,
    director: entry.type === 'movie' ? entry.director : null,
    rating: entry.type === 'movie' ? entry.rating : null,
    episodes: episodes && episodes.length > 0 ? episodes : null,
    updatedAt: new Date(),
  };
  await db
    .insert(tvdbEntries)
    .values(base)
    .onConflictDoUpdate({
      target: tvdbEntries.tvdbId,
      set: {
        slug: base.slug,
        kind: base.kind,
        title: base.title,
        titleEn: base.titleEn,
        network: base.network,
        year: base.year,
        poster: base.poster,
        matchedBy: base.matchedBy,
        totalSeasons: base.totalSeasons,
        currentSeason: base.currentSeason,
        currentEp: base.currentEp,
        totalEps: base.totalEps,
        status: base.status,
        runtime: base.runtime,
        director: base.director,
        rating: base.rating,
        // Preserve an existing non-null episode list when the new upsert
        // didn't fetch one (search-hit upsert from the auto-matcher).
        episodes: base.episodes
          ? (base.episodes as typeof tvdbEntries.$inferInsert.episodes)
          : sql`coalesce(${tvdbEntries.episodes}, null)`,
        updatedAt: base.updatedAt,
      },
    });
}

// Zenkaku-aware episode-number extraction from EPG titles. Handles `#3`,
// `＃３`, `第3話`, `第三話`, `第3回`, and `ep 3`. Returns null when the
// title has no obvious episode marker.
const KANJI_DIGITS = '零一二三四五六七八九十';
function parseTitleEpisodeNumber(title: string): number | null {
  // Zenkaku → hankaku for digits and `＃`.
  const norm = title
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/＃/g, '#');
  // #N / ＃N variants.
  const hashM = norm.match(/[#＃]\s*(\d+)/);
  if (hashM) return Number(hashM[1]);
  // 第N話 / 第N回 (ASCII digits only; kanji below).
  const kaM = norm.match(/第\s*(\d+)\s*(?:話|回|夜|局)/);
  if (kaM) return Number(kaM[1]);
  // 第N話 with kanji digits (limited to 0-99).
  const kanjiM = norm.match(/第\s*([零一二三四五六七八九十百]+)\s*(?:話|回|夜|局)/);
  if (kanjiM) return kanjiToInt(kanjiM[1]);
  // `ep 3` / `Ep.3`.
  const epM = norm.match(/\bep\.?\s*(\d+)/i);
  if (epM) return Number(epM[1]);
  return null;
}

function kanjiToInt(s: string): number | null {
  if (!s) return null;
  // 百 / 千 handling for large numbers is overkill here — episode counts
  // rarely exceed 99. Handle 一-十 + 十一-九十九.
  if (s === '十') return 10;
  const digits = s.split('').map((c) => KANJI_DIGITS.indexOf(c));
  if (digits.some((d) => d < 0)) return null;
  if (digits.length === 1) return digits[0];
  if (digits.length === 2) {
    // Forms: 十N (=10+N), N十 (=10*N), N十M requires length 3.
    if (digits[0] === 10) return 10 + digits[1];
    if (digits[1] === 10) return digits[0] * 10;
  }
  if (digits.length === 3 && digits[1] === 10) return digits[0] * 10 + digits[2];
  return null;
}

/**
 * Japanese TV "broadcast day" (放送日) — the programming day a show is
 * scheduled under. Broadcasters use the convention of labelling late-night
 * slots (01:00, 02:00…) as the *previous* day's 25時 / 26時, because a
 * night's programming block belongs to the evening that started it.
 * TVDB records `aired` in this broadcast-day calendar, so date-matching
 * must use the same shift or late-night episodes fall off by one.
 *
 * Formula: JST time minus 5 hours → take YYYY-MM-DD. The 5h boundary is
 * the de-facto industry convention (NHK, 民放 both treat 05:00 as the
 * start-of-day cutoff). Examples:
 *   - 2026-04-19T17:00Z (= 4/20 02:00 JST = 4/19 26:00) → 4/19 ✓
 *   - 2026-04-19T04:00Z (= 4/19 13:00 JST)             → 4/19 ✓
 *   - 2026-04-18T19:00Z (= 4/19 04:00 JST = 4/18 28:00) → 4/18 ✓
 */
function jstBroadcastDay(iso: string): string {
  const shifted = new Date(Date.parse(iso) + (9 - 5) * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// Given a cached episode list and a program's start timestamp + title,
// find the most likely matching episode. Resolution order:
//   1. Title has `#N` / `第N話` — pick the episode with e === N in the
//      latest season that has one. The EPG's explicit episode number is
//      the strongest signal when the broadcaster labels it.
//   2. TVDB aired === 放送日 (JST - 5h). Handles late-night slots
//      naturally without a separate fallback.
function findEpisodeForProgram(
  episodes: Array<{ s: number; e: number; aired?: string; name?: string }>,
  programStartIso: string,
  programTitle: string
): { s: number; e: number; name?: string } | null {
  // 1. Title-parsed episode number wins.
  const titleEp = parseTitleEpisodeNumber(programTitle);
  if (titleEp != null) {
    // Multi-cour / restart-numbered series: prefer the highest season
    // whose episode list contains our number.
    const candidates = episodes.filter((ep) => ep.e === titleEp);
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => (a.s >= b.s ? a : b));
      return { s: best.s, e: best.e, name: best.name };
    }
  }
  // 2. Broadcast-day match.
  const broadcastDay = jstBroadcastDay(programStartIso);
  const hit = episodes.find((ep) => ep.aired === broadcastDay);
  if (hit) return { s: hit.s, e: hit.e, name: hit.name };
  return null;
}

async function writeOverride(
  normalized: string,
  tvdbId: number | null,
  userSet: boolean
): Promise<void> {
  await db
    .insert(titleOverrides)
    .values({ normalizedTitle: normalized, tvdbId, userSet, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: titleOverrides.normalizedTitle,
      set: { tvdbId, userSet, updatedAt: new Date() },
    });
}

// -----------------------------------------------------------------
// Match service
// -----------------------------------------------------------------

export interface MatchService {
  /** Walk unmatched programs and fill their tvdb_id column. Safe to re-run. */
  enrichUnmatched(limit?: number): Promise<{ resolved: number; missed: number }>;
  /** Manual match: set tvdb_id for a program + pin the normalized title. */
  linkProgram(programId: string, tvdbId: number): Promise<TvdbEntry>;
  /** Manual unmatch: clear program.tvdb_id + pin an explicit "no match". */
  unlinkProgram(programId: string): Promise<void>;
  /**
   * Per-airing S/E override. Writes tvdb_season / tvdb_episode /
   * tvdb_episode_name for a single program only — no cohort spread. When both
   * args are numbers we look up the name from tvdb_entries.episodes; when
   * either is null we clear all three fields.
   */
  setProgramEpisode(
    programId: string,
    season: number | null,
    episode: number | null
  ): Promise<void>;
  /** In-process stats for /system. */
  stats(): { hits: number; misses: number };
}

class DbMatchService implements MatchService {
  private readonly pool = new PromisePool(MAX_CONCURRENT);
  private hits = 0;
  private misses = 0;

  async enrichUnmatched(limit = NEW_TITLES_PER_FETCH): Promise<{ resolved: number; missed: number }> {
    // 1. Pull programs that still have no match. Group by normalized title so
    //    we only hit TVDB once per distinct title.
    const unmatched = await db
      .select({ id: programs.id, title: programs.title, genreKey: programs.genreKey })
      .from(programs)
      .where(isNull(programs.tvdbId));
    if (unmatched.length === 0) return { resolved: 0, missed: 0 };

    const overrides = await loadOverrides();
    // Group by normalized title. Track whether ANY program in the group is
    // flagged as ARIB genre "映画"; we use that to gate movie-type TVDB
    // candidates below.
    const byNormalized = new Map<string, { ids: string[]; hasMovieGenre: boolean }>();
    for (const row of unmatched) {
      const key = normalizeTitle(row.title);
      if (!key) continue;
      const entry = byNormalized.get(key) ?? { ids: [], hasMovieGenre: false };
      entry.ids.push(row.id);
      if (row.genreKey === 'movie') entry.hasMovieGenre = true;
      byNormalized.set(key, entry);
    }

    // Apply existing overrides immediately; queue titles that need TVDB.
    const needsTvdb: string[] = [];
    let resolved = 0;
    let missed = 0;

    for (const [key, group] of byNormalized) {
      const { ids } = group;
      if (GENERIC_TITLES.has(key)) {
        missed += ids.length;
        continue;
      }
      const ov = overrides.get(key);
      if (ov) {
        if (ov.userSet) {
          // Explicit user decision — honor even when tvdbId is null.
          if (ov.tvdbId != null) {
            await this.applyTvdbToPrograms(ov.tvdbId, ids);
            resolved += ids.length;
          } else {
            missed += ids.length;
          }
          continue;
        }
        // Auto override — re-resolve after TTL.
        const age = Date.now() - ov.updatedAt.getTime();
        if (age < AUTO_REMATCH_TTL_MS) {
          if (ov.tvdbId != null) {
            await this.applyTvdbToPrograms(ov.tvdbId, ids);
            resolved += ids.length;
          } else {
            missed += ids.length;
          }
          continue;
        }
      }
      needsTvdb.push(key);
      if (needsTvdb.length >= limit) break;
    }

    // Hit TVDB for the remaining titles in parallel (pool-limited). When a
    // match succeeds and it's a series, also fetch the episode list so each
    // program gets the correct season/episode stamped on it.
    await Promise.all(
      needsTvdb.map((key) =>
        this.pool.run(async () => {
          const group = byNormalized.get(key);
          const ids = group?.ids ?? [];
          const allowMovie = group?.hasMovieGenre ?? false;
          try {
            let hits = await tvdbService.search(key);
            let scoreKey = key;
            let best = pickBest(hits, scoreKey, { allowMovie });
            // Documentary-style shows often come out of normalization as
            // "<show name> <episode subtitle>" separated by a single
            // space (e.g. "ブラタモリ 国宝犬山城"). When the full string
            // misses, retry the search against just the leading token —
            // that's the show name. Guarded to tokens of 3+ chars so we
            // don't blow up matches on stop-words.
            if (!best) {
              const head = key.split(/\s+/)[0] ?? '';
              if (head.length >= 3 && head !== key) {
                hits = await tvdbService.search(head);
                scoreKey = head;
                best = pickBest(hits, scoreKey, { allowMovie });
              }
            }
            if (best) {
              const episodes = best.type === 'series'
                ? await tvdbService.getSeriesEpisodes(best.id)
                : [];
              await upsertTvdbEntry(best, episodes);
              await writeOverride(key, best.id, false);
              await this.applyTvdbToPrograms(best.id, ids, episodes);
              resolved += ids.length;
              this.hits++;
            } else {
              await writeOverride(key, null, false);
              missed += ids.length;
              this.misses++;
            }
          } catch (err) {
            console.warn('[match] tvdb search failed for', key, (err as Error).message);
            missed += ids.length;
          }
        })
      )
    );

    return { resolved, missed };
  }

  private async applyTvdbToPrograms(
    tvdbId: number,
    programIds: string[],
    episodes?: Array<{ s: number; e: number; aired?: string; name?: string }>
  ): Promise<void> {
    if (programIds.length === 0) return;
    const now = new Date();
    // When the caller didn't supply an episode list (e.g. the override-hit
    // path), pull it from tvdb_entries.episodes. Saves re-fetching from
    // TVDB while still giving programs per-episode stamping.
    if (!episodes) {
      const [row] = await db
        .select({ episodes: tvdbEntries.episodes })
        .from(tvdbEntries)
        .where(eq(tvdbEntries.tvdbId, tvdbId))
        .limit(1);
      episodes = row?.episodes ?? undefined;
    }
    // Without episodes: one bulk update per chunk — fast path.
    if (!episodes || episodes.length === 0) {
      const CHUNK = 1000;
      for (let i = 0; i < programIds.length; i += CHUNK) {
        await db
          .update(programs)
          .set({ tvdbId, tvdbMatchedAt: now })
          .where(inArray(programs.id, programIds.slice(i, i + CHUNK)));
      }
      return;
    }
    // With episodes: resolve S/E per program using the cached episode list,
    // then update row-by-row. N is typically <= a few hundred.
    const CHUNK = 1000;
    // Collect unresolved programs (neither title #N nor aired-day matched) so
    // we can optionally apply a rerun-pattern sequential fallback below.
    const unresolved: Array<{ id: string; startAt: Date; title: string }> = [];
    let totalForThisTvdb = 0;
    for (let i = 0; i < programIds.length; i += CHUNK) {
      const slice = programIds.slice(i, i + CHUNK);
      const rows = await db
        .select({ id: programs.id, startAt: programs.startAt, title: programs.title })
        .from(programs)
        .where(inArray(programs.id, slice));
      for (const row of rows) {
        totalForThisTvdb++;
        const ep = findEpisodeForProgram(episodes, row.startAt.toISOString(), row.title);
        if (!ep) {
          unresolved.push({ id: row.id, startAt: row.startAt, title: row.title });
        }
        await db
          .update(programs)
          .set({
            tvdbId,
            tvdbMatchedAt: now,
            tvdbSeason: ep?.s ?? null,
            tvdbEpisode: ep?.e ?? null,
            tvdbEpisodeName: ep?.name ?? null,
          })
          .where(eq(programs.id, row.id));
      }
    }
    // Rerun-pattern sequential fallback. When a broadcaster re-airs an old
    // series (e.g. a 2021 Korean drama shown on テレビ大阪 in 2026) the EPG
    // titles usually omit episode numbers and the broadcast days don't match
    // TVDB's original `aired` dates — so the per-program matcher above misses
    // most of the slate. When the miss rate crosses 50% of a non-trivial
    // sample (>=3 programs) we assume a sequential rerun starting at S1E1 and
    // map unresolved[i] → episodes[i] in chronological order.
    if (
      totalForThisTvdb >= 3 &&
      unresolved.length / totalForThisTvdb >= 0.5
    ) {
      const sortedUnresolved = [...unresolved].sort(
        (a, b) => a.startAt.getTime() - b.startAt.getTime()
      );
      // Prefer real seasons (s >= 1) over specials (s === 0). Within that,
      // ascending by (s, e) yields S1E1, S1E2, … then S2E1, … — correct for
      // "rerun from the start" airings that may span multiple seasons.
      const realSeasons = episodes.filter((ep) => ep.s >= 1);
      const pool = realSeasons.length > 0 ? realSeasons : [...episodes];
      const sortedEpisodes = [...pool].sort((a, b) =>
        a.s !== b.s ? a.s - b.s : a.e - b.e
      );
      const pairs = Math.min(sortedUnresolved.length, sortedEpisodes.length);
      if (pairs > 0) {
        for (let i = 0; i < pairs; i++) {
          const prog = sortedUnresolved[i];
          const ep = sortedEpisodes[i];
          await db
            .update(programs)
            .set({
              tvdbId,
              tvdbMatchedAt: now,
              tvdbSeason: ep.s,
              tvdbEpisode: ep.e,
              tvdbEpisodeName: ep.name ?? null,
            })
            .where(eq(programs.id, prog.id));
        }
        const first = sortedEpisodes[0];
        const earliest = sortedUnresolved[0].startAt.toISOString();
        console.info(
          `[match] rerun pattern: tvdbId=${tvdbId}, mapped ${pairs} programs starting ${earliest} → S${first.s}E${first.e}..`
        );
      }
    }
  }

  async linkProgram(programId: string, tvdbId: number): Promise<TvdbEntry> {
    // 1. Fetch the TVDB entry + the series' episode list so we can stamp
    //    tvdb_season/tvdb_episode on each program that ends up linked.
    const fresh = await tvdbService.getById(tvdbId);
    if (!fresh) throw new Error(`tvdb entry ${tvdbId} not found`);
    const episodes = fresh.type === 'series'
      ? await tvdbService.getSeriesEpisodes(tvdbId)
      : [];
    await upsertTvdbEntry(fresh, episodes);

    // 2. Resolve the program's normalized title, pin it as a user override
    //    so every other program with the same normalized title matches too,
    //    and neither the auto-matcher TTL nor subsequent fuzzy matches
    //    overwrite this decision.
    const [prog] = await db
      .select({ title: programs.title })
      .from(programs)
      .where(eq(programs.id, programId))
      .limit(1);
    if (!prog) throw new Error(`program ${programId} not found`);
    const key = normalizeTitle(prog.title);
    if (key) await writeOverride(key, tvdbId, true);

    // 3. Update this program + every program sharing the normalized title.
    //    applyTvdbToPrograms handles the per-program episode lookup.
    await this.applyTvdbToPrograms(tvdbId, [programId], episodes);
    if (key) {
      const candidates = await db
        .select({ id: programs.id, title: programs.title })
        .from(programs)
        .where(and(isNull(programs.tvdbId), ne(programs.id, programId)));
      const ids = candidates.filter((r) => normalizeTitle(r.title) === key).map((r) => r.id);
      if (ids.length > 0) await this.applyTvdbToPrograms(tvdbId, ids, episodes);
    }
    return fresh;
  }

  async setProgramEpisode(
    programId: string,
    season: number | null,
    episode: number | null
  ): Promise<void> {
    const [prog] = await db
      .select({ tvdbId: programs.tvdbId })
      .from(programs)
      .where(eq(programs.id, programId))
      .limit(1);
    if (!prog) throw new Error(`program ${programId} not found`);

    // Clear path — either half null → wipe S/E/name.
    if (season == null || episode == null) {
      await db
        .update(programs)
        .set({
          tvdbSeason: null,
          tvdbEpisode: null,
          tvdbEpisodeName: null,
        })
        .where(eq(programs.id, programId));
      return;
    }

    // Set path — look up the episode name from the cached episode list on
    // the linked tvdb_entry. Without a tvdbId we can't resolve a name, but
    // we still allow writing the numeric S/E (name stays null).
    let episodeName: string | null = null;
    if (prog.tvdbId != null) {
      const [row] = await db
        .select({ episodes: tvdbEntries.episodes })
        .from(tvdbEntries)
        .where(eq(tvdbEntries.tvdbId, prog.tvdbId))
        .limit(1);
      const eps = row?.episodes ?? null;
      if (eps) {
        const hit = eps.find((ep) => ep.s === season && ep.e === episode);
        if (hit?.name) episodeName = hit.name;
      }
    }

    await db
      .update(programs)
      .set({
        tvdbSeason: season,
        tvdbEpisode: episode,
        tvdbEpisodeName: episodeName,
      })
      .where(eq(programs.id, programId));
  }

  async unlinkProgram(programId: string): Promise<void> {
    const [prog] = await db
      .select({ title: programs.title })
      .from(programs)
      .where(eq(programs.id, programId))
      .limit(1);
    if (!prog) return;
    const key = normalizeTitle(prog.title);
    // Pin the explicit-no-match decision via user-set override so the matcher
    // doesn't re-associate on the next refresh.
    if (key) await writeOverride(key, null, true);
    // Clear every program sharing the same normalized title.
    const candidates = await db
      .select({ id: programs.id, title: programs.title })
      .from(programs);
    const ids = candidates.filter((r) => normalizeTitle(r.title) === key).map((r) => r.id);
    if (ids.length > 0) {
      // Chunk for safety (same rationale as applyTvdbToPrograms).
      const CHUNK = 1000;
      for (let i = 0; i < ids.length; i += CHUNK) {
        await db
          .update(programs)
          .set({ tvdbId: null, tvdbMatchedAt: null })
          .where(inArray(programs.id, ids.slice(i, i + CHUNK)));
      }
    }
  }

  stats() {
    return { hits: this.hits, misses: this.misses };
  }
}

export const matchService: MatchService = new DbMatchService();
