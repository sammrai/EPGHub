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
// fold fullwidth punctuation (`！`, `？`, `＃`, `：`, `．`) to ASCII so
// subsequent regexes don't need dual branches.
//
// The `．` (U+FF0E fullwidth full stop) fold mirrors the colon / hash / bang
// folds: broadcasters render show names like `Ｄｒ．ＳＴＯＮＥ` as part of an
// all-zenkaku title, but TVDB stores the canonical `Dr.STONE` with an ASCII
// period. Without this fold, the normalized key carries `．` and the
// `scoreOf` `startsWith` / `includes` comparators against the TVDB title
// (which already uses `.`) all fail, leaving the program unmatched. Same
// structural-punctuation justification as the existing folds. Source:
// programs.id svc-3210242032_2026-05-14T13:00:00.000Z (issue #29).
function zenkakuToHankaku(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - ZENKAKU_DIGIT_OFFSET))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - ZENKAKU_ASCII_OFFSET))
    .replace(/＃/g, '#')
    .replace(/！/g, '!')
    .replace(/？/g, '?')
    .replace(/：/g, ':')
    .replace(/．/g, '.');
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
//
// The `第N<kanji>` branch accepts kanji counters in two tiers:
//
//   A. CLOSED_COUNTERS — historically-known structural markers
//      (`期|シリーズ|部|話|回|夜|局|クール|食目|週`). Match without any
//      boundary requirement so `第500回定期公演` still cuts (existing
//      behavior, regression-free).
//
//   B. Open class `[\u4E00-\u9FFF]` — any single kanji, gated by:
//      - Negative lookahead CUT_NON_COUNTER_KANJI_RE (false-positive nouns:
//        `第3戦` tournament, `第五人格` game, `交響曲第2番` music piece,
//        `第1号/代/国/人/本/個`).
//      - Negative lookahead against KANJI_DIGIT_CHARS so `第一三共` (Daiichi
//        Sankyo) doesn't read `三` as the counter when it's actually the
//        tail of a kanji compound.
//      - Positive lookahead `BOUNDARY_AFTER_COUNTER_RE` requiring whitespace,
//        quote opener, bracket, or end-of-string after the counter, so
//        `第N委員会室` (`委` followed by `員`) and `第Nロケ` are not
//        consumed.
//
//   Together these subsume the previous closed list (`輪|席|章|羽|集|…`)
//   without enumerating every show-themed glyph one-by-one. New shows that
//   invent fresh thematic counters (`第N<glyph>`) Just Work as long as the
//   broadcaster follows the standard "counter-then-quoted-subtitle" shape.
const CUT_NON_COUNTER_KANJI_RE = /(?:位|戦|弾|番|号|代|国|人|本|個)/;
const CUT_CLOSED_COUNTERS_RE = /(?:期|シリーズ|部|話|回|夜|局|クール|食目|週)/;
// Boundary that follows an open-class kanji counter. `[` / `［` cover ASCII
// / fullwidth bracket runs (`第六章[字]`); `「『」』` are quote openers and
// closers (we accept either side, since some broadcasters write the
// counter inside the quoted segment); `〔【` are NHK / OBS bracket
// variants. Whitespace + end-of-string round it out.
const BOUNDARY_AFTER_COUNTER_RE = /(?=[\s　「『」』\[［【〔]|$)/;
const CUT_AT_SEASON_RE = new RegExp(
  '[\\s　]*(?:' +
    '\\d+(?:st|nd|rd|th)\\s*[Ss]eason' +
    '|[Ss]eason\\s*\\d+' +
    '|シーズン\\s*\\d+' +
    '|第\\s*[0-9一二三四五六七八九十百千]+\\s*' +
      '(?:' +
        CUT_CLOSED_COUNTERS_RE.source +
        '|(?!' + CUT_NON_COUNTER_KANJI_RE.source +
          '|[0-9一二三四五六七八九十百千])' +
        '[\\u4E00-\\u9FFF]' + BOUNDARY_AFTER_COUNTER_RE.source +
      ')' +
    '|[#♯]\\s*\\d+' +
    '|\\d+\\s*回戦' +
  ').*$'
);

// Also cut a naked "N話" / "N回" / "N食目" when preceded by whitespace —
// used for `４話　本厚木のバーニャカウダ` (broadcaster drops the 第 prefix)
// and `6食目「うなぎ／冷奴／お祭り」` (cooking-anime thematic counter where
// the bare `<digit><thematic-counter>` form has no 第 prefix).
const CUT_AT_BARE_EP_RE = /[\s　]+\d+\s*(?:[話回]|食目)(?:[\s　].*|\s*$)/;

// Cut at the first arrow marker (▼/▽/★/◆). These are hard separators for
// the episode-of-the-week blurb.
const CUT_AT_ARROW_RE = /[▼▽★◆].*$/;

// `[xxx]　…` boundary cut. ARIB convention is for broadcasters to follow the
// canonical show name with bracket meta tags ([字][再][多][デ][SS]…) and
// then a fullwidth space before the per-airing subtitle:
//   `Ｎスタ[字]　最新中東情勢▽ハンタウイルス感染船`
// CUT_AT_ARROW_RE only handles the `▽…` tail; `最新中東情勢` between
// `[字]　` and `▽` survives unless the `[xxx]　` itself counts as a hard
// separator. Required for the auto-rule keyword path so that future
// `Ｎスタ` airings still substring-match. Matches one-or-more bracket runs
// so chained `[字][デ]　…` cuts at the run's trailing space rather than
// between the two tags. Lookbehind keeps a leading `[新]ドラマ…`-style
// preface intact (we never strip from position 0).
const CUT_AT_BRACKET_BOUNDARY_RE =
  /(?<=.)(?:[\[［【〔][^\]］】〕]*[\]］】〕])+[\s　]+.*$/;

// First subtitle-quote opener — broadcasters wrap the per-airing subtitle
// in `「…」` / `『…』` (e.g. `あさイチ「特集」`). Used by the rule-keyword
// candidate generator to find the show-name boundary; not consumed by
// `normalizeTitle` itself which has a richer extract-vs-strip path.
const SUBTITLE_OPENER_RE = /[「『]/;

// Trailing `[xxx]` (or chained `[xxx][yyy]…`) meta-tag run plus surrounding
// whitespace. Used to tidy up rule-keyword candidates whose natural cut
// happened to leave broadcaster flags like `[字]` dangling at the end
// (`ヒルナンデス！[字]` → `ヒルナンデス！`). Trailing-only by design —
// stripping middle `[xxx]` would break substring matching against future
// EPG titles that still carry the tag.
const TRAILING_BRACKETS_RE =
  /(?:[\s　]*[\[［【〔][^\]］】〕]*[\]］】〕])+[\s　]*$/;

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

// Trailing single digit glued directly to a Japanese kana/kanji — common
// sequel/season suffix on anime & dorama (異世界のんびり農家２, 進撃の巨人3,
// 晩酌の流儀2). Applied ONLY when the title wasn't extracted out of a
// `「…」` quote, because in that case the digit is part of the canonical
// title (映画「ロボコップ３」 → "ロボコップ3" — the 3 is the film's name).
// Limited to one digit so two-digit tails (ハチ公20, year tags like
// "桜2002") survive untouched. Lookbehind keeps the preceding kana/kanji.
const TRAILING_KANA_DIGIT_RE = /(?<=[\u3040-\u30FF\u4E00-\u9FFF])\d$/;

// Fullwidth Roman numeral glued to a Japanese kana/kanji — broadcaster
// sequel marker on Japanese show names (無職転生Ⅱ ～異世界行ったら本気だす～,
// 暴れん坊将軍Ⅳ #10「…」, 進撃の巨人Ⅱ). Restricted to two narrow shapes:
//
//   1. `<kana>Ⅱ` at end-of-string  — `進撃の巨人Ⅱ` after step 9 cut.
//   2. `<kana>Ⅱ` followed by `<whitespace>～...~` — the show-name-then-
//      ～subtitle～ pattern unique to broadcaster sequel naming
//      (`無職転生Ⅱ ～異世界行ったら本気だす～`). `［～〜~］` covers full-
//      and half-width tildes / wave dashes used as subtitle openers.
//
// Restricted to fullwidth U+2160..U+2169 (Ⅰ..Ⅹ) — ASCII `II`/`III`
// collides far too often with English titles. The same wasQuoteExtracted
// guard applies: skip when the title sits inside `「…」` because then the
// numeral is part of the canonical title (シネマ「ロッキーⅡ」).
//
// The narrow lookahead protects course/subject-level designations like
// `NHK高校講座 数学Ⅰ ネット社会にも権利がある` — the Ⅰ is the academic
// course level (Math I, distinct from Math II), and the trailing word is
// not a tilde-wrapped subtitle so the regex does not fire. Same protection
// for `actⅡ－…－` (em-dash, not whitespace+tilde) and `Test Ⅱ`
// (lookbehind requires kana/kanji, not ASCII).
const TRAILING_KANA_ROMAN_RE =
  /(?<=[\u3040-\u30FF\u4E00-\u9FFF])[\u2160-\u2169]+(?=$|[\s　]+[～〜~])/g;

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
  // BS11's weekday anime programming block. Always followed by an
  // individual show name (`機動戦士ガンダム 水星の魔女`, `機動戦士ガンダム
  // THE ORIGIN 前夜 赤い彗星`), so we strip the block label whole to expose
  // the show name to the matcher. The zenkaku digit variant `ＢＳ１１…` is
  // covered by the zenkaku→hankaku fold that runs before this strip.
  // Sources: programs.id svc-400211_2026-05-16T10:00:00.000Z (issue #34),
  // svc-400211_2026-05-16T10:30:00.000Z (issue #35).
  'BS11ガンダムアワー',
  'アニメ',
  'ドラマ\\d+',
  'ドラマ',
  'シネマ',
  '映画',
  '\\d+時のアニメ',
  // Broadcast-slot identifier `<weekday><hour>` used by all major commercial
  // networks (月9 / 火10 / 木10 / 日5 / 土9 …). Always followed by a space-
  // then-title or a quoted show title. Picking these up as a block prefix
  // routes `日5「夜桜さんちの大作戦」#32「愛の結晶」` through the
  // QUOTED_HOST_PREFIX_RE branch (which derives from BLOCK_PREFIXES) and
  // extracts the quoted show name, instead of falling into the else branch
  // that drops both `「…」` segments as episode subtitles.
  '[日月火水木金土]\\d+',
  // AT-X-style "Anime <Letter>" slot brand (`アニメA・<show>`,
  // `アニメB・<show>`, … through Z). Unique to AT-X and a handful of
  // sibling broadcasters; always uses `・` (Japanese middle dot) rather
  // than whitespace as the separator between the slot label and the
  // show title. The `・` is baked into this entry so the (?<=・)
  // lookbehind branch in BLOCK_PREFIX_RE accepts it as a valid
  // separator without globally relaxing the delimiter for other
  // prefixes (`ドラマ・<x>` / `アニメ<x>` no-space cases stay
  // untouched).
  'アニメ[A-Z]・',
];
const BLOCK_PREFIX_RE = new RegExp(
  // Trailing separator: either run of (whitespace|ideographic-space) OR
  // a zero-width position right after `・`. The lookbehind path is what
  // lets the `アニメ[A-Z]・` entry (which embeds its own `・` separator)
  // match without forcing a whitespace requirement on every other entry
  // — `アニメ・<title>` cases without whitespace stay protected because
  // their prefix is the literal `アニメ`, not `アニメ[A-Z]・`.
  `^(?:${BLOCK_PREFIXES.join('|')})(?:[\\s　]+|(?<=・))`
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
 *
 * ASCII-brand wide-space carve-out: broadcasters often render multi-
 * word English brand names with internal wide-space (`ＷＩＬＤ　ＢＬＵＥ`,
 * `ＷＥＥＫＬＹ　ＰＩＮＧ　ＰＯＮＧ　ＮＥＷＳ`). When the leading whitespace-
 * separated tokens are ALL pure-ASCII letters/digits, the wide-space is
 * intra-brand, not a show↔promo boundary — preserve those tokens before
 * applying the promo cut. The boundary lands at the first token that
 * begins with a non-ASCII char (kana/kanji), which is where the
 * Japanese promo or subtitle actually starts. Source: programs.id
 * svc-3272302072_2026-05-10T16:10:00.000Z (issue #22) —
 * `ＷＩＬＤ　ＢＬＵＥのわぶっていきましょう！[再]` was being clipped to
 * just `WILD` because the first whitespace fell inside the brand name.
 *
 * Embedded-`!` show-name carve-out: when the title splits into 3+
 * whitespace-separated segments AND the second segment has a
 * non-terminal `!`/`?` (i.e. content after the punctuation), the second
 * segment is treated as part of the show name (`突撃！カネオくん`-shape).
 * In that case we strip from the third segment forward, but only if a
 * later segment is itself promo-shaped (kana+`!`/`?`); otherwise we
 * fall back to the conservative "cut at first whitespace" path so we
 * don't accidentally keep an unrelated trailing subtitle. Source:
 * programs.id svc-3211240960_2026-05-10T09:05:00.000Z (issue #18) —
 * `有吉のお金発見　突撃！カネオくん　いま世界が注目！...`.
 */
function stripPromoTail(s: string): string {
  const ws = s.match(/[\s　]/);
  if (!ws) return s;
  const tail = s.slice(ws.index!);
  if (!/[\u3040-\u30FF\u4E00-\u9FFF]/.test(tail)) return s;
  if (!/[!?]/.test(tail)) return s;
  // ASCII-brand wide-space carve-out: when the segment immediately
  // BEFORE the cut is pure-ASCII letters/digits AND the segment AFTER
  // it begins with ASCII letters/digits before any kana/kanji, the
  // whitespace is intra-brand (`ＷＩＬＤ　ＢＬＵＥ` rendering of the
  // English brand `WILD BLUE`), not a show↔promo boundary. Bail out
  // entirely so the promo+kana glued onto the brand (e.g.
  // `BLUEのわぶっていきましょう!`) stays attached and the resulting
  // normalised key is long enough that a generic 4-char TVDB title
  // (`Wild`, 3496) can't pass the `scoreOf` containment-coverage floor.
  // Source: programs.id svc-3272302072_2026-05-10T16:10:00.000Z
  // (issue #22).
  const head = s.slice(0, ws.index!);
  const afterWs = s.slice(ws.index! + ws[0].length);
  if (/^[A-Za-z0-9]+$/.test(head) && /^[A-Za-z0-9]/.test(afterWs)) {
    return s;
  }
  // Split into whitespace-bounded segments to detect the embedded-`!`
  // show-name shape (`<host>　<host-with-!>　<promo>`). Only inspect when
  // there are 3+ segments — 2-segment titles always cut at the first
  // whitespace (the second segment is either pure promo or, rarely, a
  // subtitle, in which case we still want it gone for TVDB search).
  const segments = s.split(/[\s　]+/);
  if (segments.length >= 3) {
    const seg2 = segments[1] ?? '';
    const hasInternalExclaim = /[!?]/.test(seg2) && !/[!?]\s*$/.test(seg2);
    if (hasInternalExclaim) {
      // Find the first segment from index 2 onwards that is promo-shaped
      // (kana/kanji + `!`/`?`). Stripping at its boundary preserves the
      // canonical `<seg1> <seg2>` show name while still dropping the
      // promo blurb. If no later segment is promo-shaped we have no
      // structural signal that seg3+ is promo at all, so fall through
      // to the default first-whitespace cut.
      let kept = segments[0] + ' ' + seg2;
      let foundPromo = false;
      for (let i = 2; i < segments.length; i++) {
        const seg = segments[i] ?? '';
        const segHasKana = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(seg);
        const segHasExcl = /[!?]/.test(seg);
        if (segHasKana && segHasExcl) {
          foundPromo = true;
          break;
        }
        kept += ' ' + seg;
      }
      if (foundPromo) return kept;
    }
  }
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
  let wasQuoteExtracted = false;
  if (QUOTED_HOST_PREFIX_RE.test(leading)) {
    const afterPrefix = leading.replace(BLOCK_PREFIX_RE, '');
    const inner = extractQuoted(afterPrefix) ?? extractQuoted(leading);
    if (inner) {
      t = inner;
      wasQuoteExtracted = true;
    }
  } else if (leadsWithQuoted(t)) {
    const inner = extractQuoted(t);
    if (inner) {
      t = inner;
      wasQuoteExtracted = true;
    }
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

  // 11b. Strip the kana/kanji-glued sequel digit / fullwidth Roman numeral.
  //      Done after stripPromoTail so cases like `エイゴビート２　How many?/...`
  //      (digit + promo tail) lose the promo first and THEN drop the trailing
  //      marker. Skipped when the working title was extracted out of a
  //      `「…」` quote because in that case the marker is part of the
  //      canonical title (映画「ロボコップ３」, シネマ「ロッキーⅡ」).
  if (!wasQuoteExtracted) {
    t = t.replace(TRAILING_KANA_DIGIT_RE, '');
    t = t.replace(TRAILING_KANA_ROMAN_RE, '');
  }

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
// Auto-rule keyword suggestion.
//
// Pure regex heuristics can't reliably tell apart titles like
//   `Ｎスタ[字]　最新中東情勢`  — `[字]　` is the show/subtitle boundary
//   `プロフェッショナル　仕事の流儀` — `　` is part of the show name
// because the same `　` plays opposite roles. Schedule hit-counts
// disambiguate: the right cut produces a substring that matches many
// future airings, an over-eager cut still matches many but loses
// length, a too-specific cut matches only this airing and is rejected.
//
// We pick the LONGEST candidate whose substring appears in >= 2 of the
// supplied schedule titles (= shows up in at least one OTHER airing
// besides this one). Falls back to the most aggressive cut when nothing
// reaches the threshold (e.g. truly one-off broadcasts) so the rule
// still has a fighting chance to catch reruns later.
// -----------------------------------------------------------------

const RULE_KEYWORD_MIN_HITS = 2;

export function suggestRuleKeyword(
  title: string,
  scheduleTitles: readonly string[],
): string {
  const candidates = ruleKeywordCandidates(title);
  if (candidates.length === 0) return title.trim();

  for (const cand of candidates) {
    let hits = 0;
    for (const t of scheduleTitles) {
      if (t.includes(cand)) {
        hits++;
        if (hits >= RULE_KEYWORD_MIN_HITS) break;
      }
    }
    if (hits >= RULE_KEYWORD_MIN_HITS) return cand;
  }
  return candidates[candidates.length - 1];
}

function ruleKeywordCandidates(title: string): string[] {
  // Cut points are found in the zenkaku-folded title because some of the
  // existing CUT_AT_* regexes assume halfwidth digits (`#04` not `＃０４`).
  // `zenkakuToHankaku` is a 1:1 character replacement so positions in the
  // folded string apply unchanged to the original.
  const folded = zenkakuToHankaku(title);
  const positions = new Set<number>([title.length]);
  const addCutAt = (idx: number | undefined): void => {
    if (idx !== undefined && idx > 0) positions.add(idx);
  };

  for (const re of [
    SUBTITLE_OPENER_RE,
    CUT_AT_ARROW_RE,
    CUT_AT_SEASON_RE,
    CUT_AT_BARE_EP_RE,
    CUT_AT_BRACKET_BOUNDARY_RE,
  ]) {
    addCutAt(folded.match(re)?.index);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of positions) {
    const tidy = title.slice(0, p).replace(TRAILING_BRACKETS_RE, '').trim();
    if (tidy && !seen.has(tidy)) {
      seen.add(tidy);
      out.push(tidy);
    }
  }
  return out.sort((a, b) => b.length - a.length);
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

// Exported for unit tests so we can lock down behaviour around zenkaku /
// hankaku folding without spinning up TVDB or DB layers.
//
// `normalizeTitle` already folds the EPG-side key through `zenkakuToHankaku`
// (digits, Latin letters, `？！＃` → `?!#`). TVDB-side titles, however,
// frequently retain the broadcaster's original zenkaku punctuation —
// `大きい女の子は好きですか？` (U+FF1F) is a real example. Without folding
// the candidate side too, a key ending in `?` and a title ending in `？`
// fail every comparator (`===`, `startsWith`, `includes`) and the show
// scores 0 even though the strings are otherwise identical. Apply the
// same fold to the TVDB title/titleEn so the comparator sees both sides
// in the same canonical form. This is symmetric, structural, and absorbs
// the whole class of zenkaku-punctuation drift between EPG and TVDB
// without growing search-level fan-out (no extra TVDB API calls).
// Coverage floor for the asymmetric-containment branch (key ⊇ ja|en). When
// the EPG key is much longer than the TVDB title, "TVDB title is a substring
// of the EPG key" is too weak a signal — a 3-char generic word like `Bar`
// shouldn't anchor a 21-char Japanese broadcaster title (`BAR レモン・ハート
// 恋の入門ウイスキー`). Require the contained TVDB title to cover at least
// this fraction of the EPG key so containment reflects real topical overlap
// rather than a coincidental short-word substring.
//
// Calibration (sampled against the live programs ↔ tvdb_entries cache):
//   - `ブラタモリ` (4) in `ブラタモリ 国宝犬山城` (11)  → 0.36 (keep, real)
//   - `アオアシ`   (4) in `アオアシ 最初のファン` (11)   → 0.36 (keep, real)
//   - `小さな旅`   (4) in `小さな旅 選` (6)             → 0.67 (keep, real)
//   - `Bar`        (3) in `BAR レモン・ハート…` (21)     → 0.14 (reject ✗)
// 0.25 cleanly separates the two classes. Documentary-style cases ≥ 0.36
// stay matched via this branch (the head fallback in `searchKeyCandidates`
// would also rescue them, but keeping branch-6 narrow is cheaper).
const CONTAINMENT_MIN_COVERAGE = 0.25;

// Collapse whitespace around an ASCII colon so the broadcaster's bare
// `<show>：<subtitle>` form (no surrounding space, e.g. `ゴーストコンサート：
// missing Songs`) and TVDB's `<show> : <subtitle>` form (hankaku ` : ` with
// flanking spaces) compare equal after the zenkaku → hankaku fold. Same
// structural-punctuation justification as folding `？！＃` to `?!#`: both
// sources mean the same thing, only the spacing convention differs.
const COLON_SPACING_RE = /\s*:\s*/g;
function compactColon(s: string): string {
  return s.replace(COLON_SPACING_RE, ':');
}

// Strip `＜...＞` / `<...>` angle-bracket tags from the TVDB-side title so
// it lines up with the EPG-side key that already passed through
// `normalizeTitle` (which removes the same tags via `ANGLE_TAG_RE`).
// TVDB sometimes bakes the Latin-alias reading directly into the canonical
// title (`牙狼＜GARO＞-魔戒ノ花-`, series 348636). Without symmetric
// stripping the EPG key `牙狼 -魔戒ノ花-` (where the angle tag was already
// removed and replaced with whitespace) fails every `scoreOf` comparator
// against the raw TVDB title, even though both sides refer to the same
// show. Replacing the tag with a single space (not empty string) preserves
// the EPG side's residual whitespace, so the two forms collapse to the
// same canonical key after the whitespace-compact step below.
// Source: programs.id svc-400141_2026-05-14T15:30:00.000Z (issue #31).
const TVDB_ANGLE_TAG_RE = /[＜<][^＞>]*[＞>]/g;
// Collapse whitespace runs (ASCII space + ideographic space) and trim, so
// `牙狼 -魔戒ノ花-` (EPG side, residual space from angle-tag strip) and
// `牙狼-魔戒ノ花-` (TVDB after angle strip) normalise to identical strings
// regardless of how each side renders the residual whitespace.
const WHITESPACE_RUN_RE = /[\s　]+/g;
function compactWhitespace(s: string): string {
  return s.replace(WHITESPACE_RUN_RE, ' ').trim();
}

// Boundary characters TVDB consistently uses to separate the franchise
// name from a long subtitle / tagline in the canonical Japanese title.
// `<show> <subtitle>` (`本好きの下剋上 司書になるためには手段を選んでいられません`),
// `<show> : <subtitle>` (`ゴーストコンサート : missing Songs`, after the
// `\s*:\s*` → `:` collapse the boundary char IS the `:`), and
// `<show>〜<subtitle>〜` / `<show>~<subtitle>~` (tilde-wrapped subtitles
// common on broadcaster-style names). Treat the EPG key as a structural
// prefix of the TVDB title when these are the boundary char — even if
// the subtitle balloons the length ratio past the conservative
// `startsWith` floor (1.4x). The franchise-with-arc-subtitle pattern
// (本好きの下剋上 領主の養女 ↔ 本好きの下剋上 司書…) is the canonical
// case: head-fallback in `searchKeyCandidates` reduces the EPG-side key
// to the franchise name, and TVDB's canonical name is the franchise
// followed by the published subtitle.
const STRUCTURAL_BOUNDARY_RE = /[\s:～〜~\-–—]/;

// Script-variant tail detector. Some broadcasters style the
// branded suffix in ASCII Latin (`こめかみっ!Girls`) while TVDB
// stores the official Japanese rendering with the same suffix
// transliterated to katakana (`こめかみっ! ガールズ`). The two
// titles share a CJK franchise prefix that ends at `!`/`?` and
// diverge only at the script of the trailing brand word, so a
// boundary-aware prefix match is reliable when the divergent
// tails are script-disjoint: one is pure ASCII Latin, the other
// is pure katakana (no overlap → no accidental partial-text
// collision with unrelated shows). Source: programs.id
// svc-400211_2026-05-12T16:00:00.000Z (issue #37).
const ASCII_LATIN_TAIL_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const KATAKANA_TAIL_RE = /^[\u30A0-\u30FF\u30FC]+$/;
const CJK_PREFIX_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g;

/**
 * Score a TVDB title vs an EPG key when the two share a CJK prefix
 * terminated by `!`/`?` and their tails are script-disjoint (one pure
 * ASCII Latin, the other pure katakana). Returns 0 when the structural
 * shape doesn't match. See the call site in `scoreOf` for the rationale.
 */
function scoreScriptVariantTail(ja: string, key: string): number {
  // Find the latest `!` or `?` in `key` that is preceded by ≥ 4 CJK
  // kana/kanji chars. Anchor on the EPG-side key because that's the
  // canonical brand boundary on the broadcaster side.
  let cut = -1;
  for (let i = key.length - 1; i >= 0; i--) {
    const ch = key[i];
    if (ch === '!' || ch === '?') {
      const head = key.slice(0, i);
      const cjkCount = (head.match(CJK_PREFIX_RE) ?? []).length;
      if (cjkCount >= 4) { cut = i; break; }
    }
  }
  if (cut < 0) return 0;
  const prefix = key.slice(0, cut + 1);
  if (!ja.startsWith(prefix)) return 0;
  const keyTail = key.slice(cut + 1).trim();
  const jaTail = ja.slice(prefix.length).trim();
  if (!keyTail || !jaTail) return 0;
  const keyTailIsLatin = ASCII_LATIN_TAIL_RE.test(keyTail);
  const jaTailIsKatakana = KATAKANA_TAIL_RE.test(jaTail);
  const keyTailIsKatakana = KATAKANA_TAIL_RE.test(keyTail);
  const jaTailIsLatin = ASCII_LATIN_TAIL_RE.test(jaTail);
  const scriptDisjoint =
    (keyTailIsLatin && jaTailIsKatakana) || (keyTailIsKatakana && jaTailIsLatin);
  if (!scriptDisjoint) return 0;
  const lenA = keyTail.length;
  const lenB = jaTail.length;
  const ratio = Math.max(lenA, lenB) / Math.max(1, Math.min(lenA, lenB));
  if (ratio > 1.8) return 0;
  return 620 - ja.length;
}

export function scoreOf(e: TvdbEntry, key: string): number {
  const ja = compactWhitespace(
    compactColon(zenkakuToHankaku((e.title ?? '').trim()).replace(TVDB_ANGLE_TAG_RE, ' ')),
  );
  const en = compactWhitespace(
    compactColon(zenkakuToHankaku((e.titleEn ?? '').trim()).replace(TVDB_ANGLE_TAG_RE, ' ')),
  );
  key = compactWhitespace(compactColon(key));
  const kLower = key.toLowerCase();
  if (ja === key || en === key) return 1000;
  if (en.toLowerCase() === kLower) return 950;
  const jaLenRatio = ja.length / Math.max(1, key.length);
  const enLenRatio = en.length / Math.max(1, key.length);
  if (jaLenRatio <= 1.4 && ja.startsWith(key)) return 700 - ja.length;
  if (enLenRatio <= 1.4 && en.toLowerCase().startsWith(kLower)) return 680 - en.length;
  // Franchise-with-subtitle relaxation: when the TVDB title starts with
  // the EPG key AND the next char is a structural delimiter, the ratio
  // floor doesn't apply — the rest of `ja` is a published subtitle, not
  // an unrelated title. Gated by `key.length >= 4` so generic 3-char
  // openers (`THE`, `BAR`, `ニュース`-ish) can't ride this branch.
  // Source: programs.id svc-3272502088_2026-05-16T08:30:00.000Z (issue #33).
  if (
    key.length >= 4 &&
    ja.startsWith(key) &&
    STRUCTURAL_BOUNDARY_RE.test(ja[key.length] ?? '')
  ) {
    return 650 - ja.length;
  }
  if (
    key.length >= 4 &&
    en.toLowerCase().startsWith(kLower) &&
    STRUCTURAL_BOUNDARY_RE.test(en[key.length] ?? '')
  ) {
    return 630 - en.length;
  }
  // Script-variant tail relaxation: TVDB stores the franchise + katakana
  // rendering (`こめかみっ! ガールズ`) while the broadcaster styles the
  // brand suffix in ASCII Latin (`こめかみっ!Girls`). The shared CJK
  // prefix ends at a `!`/`?` show-name boundary; the divergent tails are
  // script-disjoint (one pure ASCII Latin, the other pure katakana) so
  // there is no possibility of a partial-text collision with an unrelated
  // entry. Gated tightly:
  //   - The shared prefix must end with `!` or `?` AND contain ≥ 4 CJK
  //     kana/kanji chars — short generic prefixes can't ride this branch.
  //   - One tail pure ASCII-Latin (≥ 1 char, alpha first), the other
  //     pure katakana. No mixed script on either side.
  //   - Tail lengths within a 1.8x ratio so a 3-char Latin word can't
  //     anchor a 20-char katakana tail (or vice versa).
  // Source: programs.id svc-400211_2026-05-12T16:00:00.000Z (issue #37).
  const variant = scoreScriptVariantTail(ja, key);
  if (variant > 0) return variant;
  if (jaLenRatio <= 1.6 && ja.includes(key)) return 500 - ja.length;
  if (key.length >= 4) {
    const minCovered = key.length * CONTAINMENT_MIN_COVERAGE;
    const jaCovers = ja.length >= minCovered && key.includes(ja);
    const enCovers = en.length >= minCovered && key.toLowerCase().includes(en.toLowerCase());
    if (jaCovers || enCovers) return 300;
  }
  return 0;
}

/**
 * Build the ordered list of search keys for show-name resolution in
 * `enrichUnmatched` / `rematchProgram`. Each later candidate is a
 * progressive relaxation of the primary key; callers iterate and stop
 * at the first scoring hit.
 *
 * Today the only relaxation is the leading-token fallback (covers
 * documentary-style `<show> <subtitle>` like
 * `ブラタモリ 国宝犬山城` → `ブラタモリ`). New relaxations should be
 * added here ONLY when they cannot be folded into `normalizeTitle`'s
 * strip rules — every fan-out candidate is one extra `tvdbService.search`
 * call against a rate-limited API. Trailing structural markers
 * (kana-glued digits / fullwidth Roman numerals) live in
 * `TRAILING_KANA_DIGIT_RE` / `TRAILING_KANA_ROMAN_RE` instead, where
 * one regex absorbs the whole class without an extra search.
 *
 * Exported for unit tests so the relaxation order can be locked
 * without spinning up the DB / HTTP layers.
 */
export function searchKeyCandidates(key: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(key);
  const tokens = key.split(/\s+/);
  const head = tokens[0] ?? '';
  // Length floor differs by script: a 3-char CJK kana/kanji head
  // (`タッチ`, `朱蒙` is already 2 → blocked, `あさイチ` is 4 → kept) is
  // typically a meaningful show name, but a 3-char ASCII head (`BAR`,
  // `THE`, `OUR`) is almost always a generic English/genre word that
  // collides with hundreds of unrelated TVDB titles. Without this guard
  // a broadcaster title like `BAR レモン・ハート 恋の入門ウイスキー`
  // would fan out to head=`BAR` and exact-match the unrelated TVDB show
  // `Bar` (3 chars). Promotion to len ≥ 4 for ASCII-only heads
  // structurally separates "show name token" from "noise opener" without
  // a per-show literal guard.
  const isAsciiOnly = /^[\x20-\x7E]+$/.test(head);
  const minHeadLen = isAsciiOnly ? 4 : 3;
  // ASCII-brand wide-space guard: if BOTH the head and its immediate
  // successor are pure-ASCII letter/digit tokens, the head is a brand
  // fragment (`WILD` of `WILD BLUE…`), not a standalone show name.
  // Suppressing the head fanout here prevents the matcher from doing a
  // search on `WILD` and binding the program to TVDB's generic 4-char
  // `Wild` entry — same structural class as the BAR-vs-Bar guard above,
  // but for brand names whose internal whitespace meets the length
  // floor on each side. Source: programs.id
  // svc-3272302072_2026-05-10T16:10:00.000Z (issue #22).
  const next = tokens[1] ?? '';
  const headIsAsciiBrandFragment =
    isAsciiOnly && next.length > 0 && /^[A-Za-z0-9]/.test(next);
  if (head.length >= minHeadLen && !headIsAsciiBrandFragment) push(head);
  return out;
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
// `＃３`, `第3話`, `第三話`, `第捌話` (daiji 大字), `第3回`, `ep 3`, and
// `（NN）` (NHK 連続テレビ小説 daily-episode format). Returns null when
// the title has no obvious episode marker.
//
// KANJI_DIGIT_MAP carries both standard kanji numerals (一二三…) and the
// formal 大字 forms (壱弐参肆伍陸漆捌玖拾) sometimes used by anime/drama
// EPG titles for stylistic effect. Mapping by character preserves the
// same indexing semantics as the original `KANJI_DIGITS.indexOf` table
// while extending coverage.
const KANJI_DIGIT_MAP: Record<string, number> = {
  '零': 0, '〇': 0,
  '一': 1, '壱': 1, '壹': 1,
  '二': 2, '弐': 2, '貳': 2, '弍': 2,
  '三': 3, '参': 3, '參': 3,
  '四': 4, '肆': 4,
  '五': 5, '伍': 5,
  '六': 6, '陸': 6,
  '七': 7, '漆': 7, '柒': 7,
  '八': 8, '捌': 8,
  '九': 9, '玖': 9,
  '十': 10, '拾': 10,
  '百': 100,
};
const KANJI_DIGIT_CHARS = Object.keys(KANJI_DIGIT_MAP).join('');

// Episode-number parsing uses the same dual-tier approach as
// CUT_AT_SEASON_RE — see that comment for the full rationale. The
// difference is that the parser's closed set is narrower: it excludes
// season selectors (`期|部|シリーズ|クール|週`) because those identify a
// season, not an episode index. `輪|席|章|羽|集` and any other show-themed
// glyph fall through to the open class with the boundary lookahead.
const PARSE_CLOSED_COUNTERS_RE = /(?:話|回|夜|局|食目)/;
const PARSE_OPEN_COUNTER_BODY =
  '(?!' + CUT_NON_COUNTER_KANJI_RE.source +
    '|期|部|週|シリーズ|クール|' +
    `[${KANJI_DIGIT_CHARS}])` +
  '[\\u4E00-\\u9FFF]' + BOUNDARY_AFTER_COUNTER_RE.source;
const TITLE_EP_DIGIT_RE = new RegExp(
  '第\\s*(\\d+)\\s*(?:' +
    PARSE_CLOSED_COUNTERS_RE.source + '|' + PARSE_OPEN_COUNTER_BODY +
  ')'
);
const KANJI_NUMBER_RE = new RegExp(
  `第\\s*([${KANJI_DIGIT_CHARS}]+)\\s*(?:` +
    PARSE_CLOSED_COUNTERS_RE.source + '|' + PARSE_OPEN_COUNTER_BODY +
  ')'
);

function parseTitleEpisodeNumber(title: string): number | null {
  // Zenkaku → hankaku for digits and `＃`.
  const norm = title
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/＃/g, '#');
  // #N / ＃N variants.
  const hashM = norm.match(/[#＃]\s*(\d+)/);
  if (hashM) return Number(hashM[1]);
  // 第N<kanji-counter> with ASCII digits — generic match, see comment on
  // TITLE_EP_DIGIT_RE for the blocklist.
  const kaM = norm.match(TITLE_EP_DIGIT_RE);
  if (kaM) return Number(kaM[1]);
  // 第N<kanji-counter> with kanji / 大字 digits (limited to 0-99).
  const kanjiM = norm.match(KANJI_NUMBER_RE);
  if (kanjiM) return kanjiToInt(kanjiM[1]);
  // `ep 3` / `Ep.3`.
  const epM = norm.match(/\bep\.?\s*(\d+)/i);
  if (epM) return Number(epM[1]);
  // Zenkaku parenthesised number `（NN）` — used by NHK 連続テレビ小説 to
  // mark the cumulative daily episode number (`風、薫る（３１）第７週「届かぬ声」`).
  // Restricted to fullwidth parens so we don't mis-read year tags like
  // `(2025)` or runtime markers like `(60min)`.
  const parenM = norm.match(/（\s*(\d{1,3})\s*）/);
  if (parenM) return Number(parenM[1]);
  // Bare `N話` / `N回` / `N食目` preceded by whitespace or string start —
  // broadcasters who drop the `第` prefix (`孤独のグルメSeason11 3話 ...`,
  // `４話 本厚木の…`, `メイドさんは食べるだけ 6食目「…」`). Whitespace
  // requirement avoids matching `Season11` mid-string and ensures the
  // digit is actually a standalone episode marker, not the tail of a
  // series name.
  const bareM = norm.match(/(?:^|[\s　])(\d+)\s*(?:[話回]|食目)/);
  if (bareM) return Number(bareM[1]);
  return null;
}

function kanjiToInt(s: string): number | null {
  if (!s) return null;
  const digits = s.split('').map((c) => KANJI_DIGIT_MAP[c]);
  if (digits.some((d) => d == null)) return null;
  // Single-character forms: returns the mapped value directly
  // (e.g. 捌→8, 十→10, 百→100).
  if (digits.length === 1) return digits[0];
  // Two-character forms: 十N (=10+N), N十 (=10*N).
  if (digits.length === 2) {
    if (digits[0] === 10) return 10 + digits[1];
    if (digits[1] === 10) return digits[0] * 10;
  }
  // Three-character forms: N十M (=10*N+M). 百-prefixed forms are not
  // expected for episode counts and intentionally fall through to null.
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

// Normalize an episode name for cross-source equality. EPG and TVDB
// disagree on zenkaku vs hankaku (digits, ASCII letters, `！？＃`) and on
// whitespace, but the underlying text is the same. Lowercase + strip all
// whitespace + fold zenkaku gives a stable key for direct comparison.
function normalizeEpisodeName(s: string): string {
  return zenkakuToHankaku(s).replace(/[\s　]+/g, '').toLowerCase();
}

/**
 * Derive the episode subtitle from an EPG title by subtraction:
 * `EPG title − show name − structural noise = subtitle`.
 *
 * Listing every possible delimiter (`▼`, `「」`, `▽`, `★`, …) is fragile;
 * broadcasters keep inventing new ones. Instead, we rely on the fact that
 * we *know* the show name (from the linked TVDB entry) and that the rest
 * of the title is a stable mix of episode-meta noise (brackets, parens,
 * episode numbers, broadcast flags) and the actual subtitle. Stripping
 * the noise leaves the subtitle.
 *
 * Returns null when nothing meaningful remains.
 */
function deriveEpisodeSubtitle(programTitle: string, showTitles: string[]): string | null {
  let s = programTitle;

  // Strip occurrences of the show name(s). Sort longer first so when the
  // JA title contains the EN one (or vice versa) we don't strip a partial
  // fragment and leave dangling chars.
  const titles = [...new Set(showTitles)]
    .filter((t): t is string => Boolean(t && t.trim()))
    .sort((a, b) => b.length - a.length);
  for (const name of titles) {
    s = s.split(name).join(' ');
  }

  // Bracketed markers `[字]`, `【…】`, `〔…〕`, `［…］`.
  s = s.replace(/[\[［【〔][^\]］】〕]*[\]］】〕]/g, ' ');
  // Angle tags `＜…＞` / `<…>`.
  s = s.replace(/[＜<][^＞>]*[＞>]/g, ' ');
  // Parenthesised content `（…）` / `(…)` — runtime / year / weekday tags
  // and NHK 朝ドラ `（NN）`. The numeric value is extracted separately by
  // parseTitleEpisodeNumber when needed.
  s = s.replace(/[（(][^）)]*[)）]/g, ' ');

  // Episode markers — `#N`, `＃N`, `第N<counter>`. Mirrors the CUT_AT_SEASON
  // tiered structure: closed counters (incl. season selectors `期/部/週/
  // シリーズ/クール`) strip without boundary; open-class kanji strips with
  // a boundary after to avoid eating compound nouns. The strip is broader
  // than the parse blocklist because even structural `第N期/部/週` is
  // show-name metadata that doesn't belong in a subtitle candidate.
  s = s.replace(/[#＃♯]\s*[\d０-９]+/g, ' ');
  s = s.replace(
    new RegExp(
      '第\\s*[\\d０-９' + KANJI_DIGIT_CHARS + ']+\\s*(?:' +
        CUT_CLOSED_COUNTERS_RE.source +
        '|(?!' + CUT_NON_COUNTER_KANJI_RE.source +
          '|[\\d０-９' + KANJI_DIGIT_CHARS + '])' +
        '[\\u4E00-\\u9FFF]' + BOUNDARY_AFTER_COUNTER_RE.source +
      ')',
      'g',
    ),
    ' '
  );
  // Bare `<digit>食目` (no 第 prefix) — same shape as the bare branch
  // in parseTitleEpisodeNumber. Strip so it doesn't poison the
  // subtitle candidate.
  s = s.replace(/[\d０-９]+\s*食目/g, ' ');

  // English / katakana season markers — `<N>(st|nd|rd|th) Season`,
  // `Season<N>`, `シーズン<N>`. Mirrors the same shapes already covered
  // by CUT_AT_SEASON_RE, but applied here in subtraction mode (strip
  // just the marker, not the tail) because the per-airing subtitle
  // follows the marker (`BanG Dream! 2nd Season　#11　ホシノナミダ` →
  // the subtitle `ホシノナミダ` is what we want to keep). Without this
  // strip, the residue would carry `2nd Season` and the equality
  // check against the TVDB episode name fails — driving the matcher
  // into the `#N` fallback which picks the highest season carrying
  // e===N (S3E11 「パレオはもういません」) instead of S2E11.
  // Source: programs.id svc-400141_2026-05-14T15:00:00.000Z (issue #32).
  s = s.replace(/[\d０-９]+\s*(?:st|nd|rd|th)\s*[Ss]eason/g, ' ');
  s = s.replace(/[Ss]eason\s*[\d０-９]+/g, ' ');
  s = s.replace(/シーズン\s*[\d０-９]+/g, ' ');

  // Standalone single zenkaku/hankaku digit residue — broadcasters glue a
  // bare season marker onto the show name (`異世界のんびり農家２`,
  // `魔入りました！入間くん４`, `進撃の巨人3`); after the show-name strip
  // above, that digit is left orphaned as a 1-char token between
  // separators (whitespace, quote-bracket, or end-of-string). Without
  // this, the digit contaminates the residue and the derived subtitle
  // candidate fails to match the TVDB episode name. Constraints:
  //   - exactly ONE digit (preserves year tags `2026`, runtime `120`,
  //     and `30年` shapes that the kanji-prefix-digit strip below also
  //     guards against),
  //   - preceded by whitespace or start-of-string,
  //   - followed by whitespace, a quote-bracket opener, or end-of-string
  //     (so `30年` / `110キロ` / `2026年` / `4DX` shapes are preserved —
  //     in all those the digit is followed by kana/kanji/letters, not a
  //     separator).
  // Runs BEFORE the quote-bracket strip so a `<digit>「subtitle」` shape
  // (no whitespace between digit and quote) still fires via the `[「『]`
  // lookahead branch.
  s = s.replace(/(?<=^|[\s　])[\d０-９](?=$|[\s　「『])/g, ' ');

  // Standalone fullwidth Roman-numeral residue — same justification as the
  // digit residue above, but for broadcaster sequel markers written as
  // Roman numerals (`鬼平犯科帳Ⅴ`, `暴れん坊将軍Ⅳ`, `必殺仕事人Ⅲ`). After
  // the show-name strip those numerals are left orphaned between
  // separators just like a bare digit. Without this branch the residue
  // (`Ⅴ 市松小僧始末`) keeps the numeral glued to the subtitle and the
  // `normalizeEpisodeName` equality check against TVDB's bare
  // `市松小僧始末` fails.
  // Restricted to fullwidth U+2160..U+2169 (Ⅰ..Ⅹ) — ASCII `II`/`III`
  // collides too often with real subtitle content and substrings of
  // show titles. Boundary lookbehind/lookahead match the digit residue
  // branch so `<numeral>「subtitle」` (no whitespace) still fires.
  // Source: programs.id svc-3210242032_2026-05-13T10:00:00.000Z
  // (issue #27).
  s = s.replace(/(?<=^|[\s　])[\u2160-\u2169]+(?=$|[\s　「『])/g, ' ');

  // Quote brackets — keep the inside, drop the wrappers.
  s = s.replace(/[「」『』]/g, ' ');

  // Punctuation/decorative markers used as section separators in titles.
  // `▼▽` introduces description; `★◆■□●○◇◎※` are highlight bullets.
  s = s.replace(/[▼▽★◆■□●○◇◎※→←]/g, ' ');

  // Collapse whitespace runs and trim.
  s = s.replace(/[\s　]+/g, ' ').trim();
  // Drop common standalone noise tokens that survived the structural pass.
  s = s.replace(/\b(?:再|新|字|解|HD|デ)\b/g, '').trim();

  // Show-themed bare counter `<2-4 kanji><digit>` — broadcasters use show-
  // internal labels like `作戦31` (`夜桜さんち` "Operation N"), `事件第N号`,
  // etc. as a per-airing counter, with a real subtitle following in the
  // same field (`作戦31 スパイ昇級試験`). Constrained to:
  //   - 2-4 kanji prefix (rules out single-kanji `第N` already handled
  //     above; rules out long sentences),
  //   - hankaku/zenkaku digits,
  //   - REQUIRED trailing whitespace (rules out year/length attributes
  //     glued to following kanji like `平成30年` / `刑事110キロ` and
  //     end-of-string trailing season-suffixes like `加賀美塔子2`),
  //   - REQUIRED preceding whitespace or start-of-string.
  // Runs after the show-name strip so a show whose title legitimately
  // contains this shape (`加賀美塔子2`) is never seen here.
  s = s
    .replace(
      /(?<=^|[\s　])[\u4E00-\u9FFF]{2,4}[\d０-９]+[\s　]/g,
      ' '
    )
    .replace(/[\s　]+/g, ' ')
    .trim();

  // Re-apply the block-prefix strip on the residue. The show name lived
  // between `アニメ` and the rest of the title, so removing it left
  // `アニメ` orphaned at the head of the residue (`アニメ スパイ昇級試験`).
  // Without this, any broadcast prefix (`アニメ`, `ドラマ`, `日5`, …)
  // contaminates the subtitle candidate and blocks the name match.
  s = s.replace(BLOCK_PREFIX_RE, '').trim();

  return s.length >= 2 ? s : null;
}

// Given a cached episode list and a program's start timestamp + title,
// find the most likely matching episode. Resolution order, strongest
// signal first:
//   1. Subtitle name match. Strip the show name and structural noise
//      from the EPG title (`deriveEpisodeSubtitle`); whatever is left is
//      a subtitle candidate that gets compared against the cached episode
//      `name` list. Series-unique → pins the season directly. Falls back
//      to extracting any `「…」`/`『…』` segments when the caller didn't
//      supply show titles (older test paths).
//   2. Episode number from the title (`#N` / `第N話`). Same season picked
//      as the highest one carrying e === N — kept as a fallback for
//      titles that omit the subtitle.
//   3. Cumulative-N fallback for restart-numbered series (e.g. ダンダダン
//      #18 = S1 12話 + S2 6話 = S2E6).
//   4. TVDB aired === 放送日 (JST - 5h). Handles late-night slots
//      naturally without a separate fallback.
//
// Exported for unit tests — tests bypass the DB and hand-roll an
// `episodes` array per case.
export function findEpisodeForProgram(
  episodes: Array<{ s: number; e: number; aired?: string; name?: string }>,
  programStartIso: string,
  programTitle: string,
  showTitles?: string[]
): { s: number; e: number; name?: string } | null {
  // 1. Subtitle-derived name match.
  const candidates: string[] = [];
  if (showTitles && showTitles.length > 0) {
    const derived = deriveEpisodeSubtitle(programTitle, showTitles);
    if (derived) candidates.push(derived);
  } else {
    // Backward-compat path: when the caller hasn't supplied show titles,
    // extract every quoted segment as a subtitle candidate.
    for (const m of programTitle.matchAll(/[「『]([^「」『』]+)[」』]/g)) {
      candidates.push(m[1]);
    }
  }
  if (candidates.length > 0) {
    const namedHits: Array<{ s: number; e: number; name?: string }> = [];
    for (const cand of candidates) {
      const candKey = normalizeEpisodeName(cand);
      if (!candKey) continue;
      for (const ep of episodes) {
        if (ep.name && normalizeEpisodeName(ep.name) === candKey) {
          namedHits.push(ep);
        }
      }
    }
    if (namedHits.length > 0) {
      // Dedupe by (s,e) — the same episode may appear multiple times if
      // multiple candidate strings happened to match its name.
      const deduped = Array.from(
        new Map(namedHits.map((ep) => [`${ep.s}-${ep.e}`, ep])).values()
      );
      const realSeasons = deduped.filter((ep) => ep.s >= 1);
      const tier = realSeasons.length > 0 ? realSeasons : deduped;
      // Only return when the name uniquely identifies an episode in the
      // chosen tier. Some series reuse subtitles across seasons (ダンダダン
      // S1E8 と S2E7 がどちらも `なんかモヤモヤするじゃんよ`); when the
      // name match is ambiguous, abstain and let step 2 / cumulative
      // disambiguate via the explicit episode number.
      if (tier.length === 1) {
        const pick = tier[0];
        return { s: pick.s, e: pick.e, name: pick.name };
      }
    }
  }

  // 2. Title-parsed episode number.
  const titleEp = parseTitleEpisodeNumber(programTitle);
  if (titleEp != null) {
    const candidates = episodes.filter((ep) => ep.e === titleEp);
    if (candidates.length > 0) {
      // Fresh airings normally point at the current/latest cour, so the
      // highest season carrying e===N wins by default. When the title
      // explicitly carries a 再放送 marker (`[再]` / `［再］`), it's a
      // rerun of an older season — prefer the lowest season instead.
      // Specials (s=0) deprioritised either way.
      const realSeasons = candidates.filter((ep) => ep.s >= 1);
      const tier = realSeasons.length > 0 ? realSeasons : candidates;
      const isRerun = /[\[［]\s*再\s*[\]］]/.test(programTitle);
      const best = tier.reduce((a, b) =>
        isRerun ? (a.s < b.s ? a : b) : (a.s >= b.s ? a : b)
      );
      return { s: best.s, e: best.e, name: best.name };
    }
    // 3. Cumulative-N fallback. Only kicks in when direct match is empty
    // — otherwise a long single-season show with E18 would get pulled
    // into S2 even though S1 already has the right episode.
    const seasons = Array.from(new Set(
      episodes.filter((ep) => ep.s >= 1).map((ep) => ep.s)
    )).sort((a, b) => a - b);
    let acc = 0;
    for (const s of seasons) {
      const eps = episodes.filter((ep) => ep.s === s);
      if (eps.length === 0) continue;
      const maxE = eps.reduce((m, ep) => (ep.e > m ? ep.e : m), 0);
      if (titleEp <= acc + maxE) {
        const rel = titleEp - acc;
        const hit = eps.find((ep) => ep.e === rel);
        if (hit) return { s: hit.s, e: hit.e, name: hit.name };
        break; // titleEp belongs to this season but no matching e — give up
      }
      acc += maxE;
    }
  }
  // 4. Broadcast-day match.
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
  /**
   * Single-program rematch. For a *matched* program: re-fetch the TVDB
   * entry (and the series episode list when applicable) and re-apply the
   * S/E lookup so matcher improvements / new episodes propagate without
   * waiting for the next bulk run. For an *unmatched* program: run the
   * same auto-search the bulk matcher uses, ignoring stale overrides so
   * the user can retry after fixing a normalization rule. Returns the
   * resolved entry, or `null` when no match was found.
   */
  rematchProgram(programId: string): Promise<TvdbEntry | null>;
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
            // Iterate the candidate list (primary → progressive
            // relaxations) and stop at the first scoring hit. See
            // `searchKeyCandidates` for the order rationale.
            const candidates = searchKeyCandidates(key);
            let best: TvdbEntry | null = null;
            for (const scoreKey of candidates) {
              const hits = await tvdbService.search(scoreKey);
              best = pickBest(hits, scoreKey, { allowMovie });
              if (best) break;
            }
            if (best) {
              const episodes = best.type === 'series'
                ? await tvdbService.getSeriesEpisodes(best.id)
                : [];
              await upsertTvdbEntry(best, episodes);
              await writeOverride(key, best.id, false);
              const showTitles = [best.title, best.titleEn].filter(
                (t): t is string => Boolean(t)
              );
              await this.applyTvdbToPrograms(best.id, ids, episodes, showTitles);
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
    episodes?: Array<{ s: number; e: number; aired?: string; name?: string }>,
    showTitles?: string[]
  ): Promise<void> {
    if (programIds.length === 0) return;
    const now = new Date();
    // When the caller didn't supply an episode list / show titles (e.g.
    // the override-hit path), pull both from tvdb_entries. Saves
    // re-fetching from TVDB while still giving programs per-episode
    // stamping AND letting `findEpisodeForProgram` derive subtitles.
    if (!episodes || !showTitles) {
      const [row] = await db
        .select({
          title: tvdbEntries.title,
          titleEn: tvdbEntries.titleEn,
          episodes: tvdbEntries.episodes,
        })
        .from(tvdbEntries)
        .where(eq(tvdbEntries.tvdbId, tvdbId))
        .limit(1);
      if (!episodes) episodes = row?.episodes ?? undefined;
      if (!showTitles && row) {
        showTitles = [row.title, row.titleEn].filter(
          (t): t is string => Boolean(t)
        );
      }
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
    //
    // When `findEpisodeForProgram` returns null we leave (s,e) NULL on
    // purpose — matchService is responsible for honest confidence, the
    // recording filename layer (`plexNaming.plexPath`) handles uniqueness
    // for null-tagged airings via `<title> - <stamp>_<id8>.<ext>`. This
    // avoids the historical "rerun-pattern fallback" that estimated S/E
    // from chronological order; that fallback was wrong far more often
    // than right and poisoned the Plex library with confident-looking
    // wrong metadata.
    const CHUNK = 1000;
    for (let i = 0; i < programIds.length; i += CHUNK) {
      const slice = programIds.slice(i, i + CHUNK);
      const rows = await db
        .select({ id: programs.id, startAt: programs.startAt, title: programs.title })
        .from(programs)
        .where(inArray(programs.id, slice));
      for (const row of rows) {
        const ep = findEpisodeForProgram(
          episodes,
          row.startAt.toISOString(),
          row.title,
          showTitles
        );
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
    const showTitles = [fresh.title, fresh.titleEn].filter(
      (t): t is string => Boolean(t)
    );
    await this.applyTvdbToPrograms(tvdbId, [programId], episodes, showTitles);
    if (key) {
      const candidates = await db
        .select({ id: programs.id, title: programs.title })
        .from(programs)
        .where(and(isNull(programs.tvdbId), ne(programs.id, programId)));
      const ids = candidates.filter((r) => normalizeTitle(r.title) === key).map((r) => r.id);
      if (ids.length > 0) await this.applyTvdbToPrograms(tvdbId, ids, episodes, showTitles);
    }
    return fresh;
  }

  async rematchProgram(programId: string): Promise<TvdbEntry | null> {
    const [prog] = await db
      .select({
        id: programs.id,
        title: programs.title,
        genreKey: programs.genreKey,
        tvdbId: programs.tvdbId,
      })
      .from(programs)
      .where(eq(programs.id, programId))
      .limit(1);
    if (!prog) throw new Error(`program ${programId} not found`);

    // Already matched — refresh the cached TVDB entry + episode list and
    // re-apply S/E for this program. We deliberately do NOT touch the
    // override here (no user_set flip); this is a "refresh metadata"
    // action, not a "user confirms link" action.
    if (prog.tvdbId != null) {
      const fresh = await tvdbService.getById(prog.tvdbId);
      if (!fresh) return null;
      const episodes = fresh.type === 'series'
        ? await tvdbService.getSeriesEpisodes(prog.tvdbId)
        : [];
      await upsertTvdbEntry(fresh, episodes);
      const showTitles = [fresh.title, fresh.titleEn].filter(
        (t): t is string => Boolean(t)
      );
      await this.applyTvdbToPrograms(prog.tvdbId, [programId], episodes, showTitles);
      return fresh;
    }

    // Unmatched — run an on-demand auto-search. Mirrors the search/scoring
    // path in `enrichUnmatched`, but scoped to this single program.
    // Existing overrides are intentionally bypassed: the user clicking
    // "再マッチ" implies they want a fresh attempt regardless of a stale
    // null-override pinned by a prior failed run.
    const key = normalizeTitle(prog.title);
    if (!key || GENERIC_TITLES.has(key)) return null;

    const allowMovie = prog.genreKey === 'movie';
    // Same fan-out as `enrichUnmatched`: try the primary key, then
    // progressively relaxed candidates (see `searchKeyCandidates`).
    const searchKeys = searchKeyCandidates(key);
    let best: TvdbEntry | null = null;
    for (const scoreKey of searchKeys) {
      const hits = await tvdbService.search(scoreKey);
      best = pickBest(hits, scoreKey, { allowMovie });
      if (best) break;
    }

    if (!best) {
      await writeOverride(key, null, false);
      this.misses++;
      return null;
    }

    const episodes = best.type === 'series'
      ? await tvdbService.getSeriesEpisodes(best.id)
      : [];
    await upsertTvdbEntry(best, episodes);
    await writeOverride(key, best.id, false);

    const showTitles = [best.title, best.titleEn].filter(
      (t): t is string => Boolean(t)
    );
    await this.applyTvdbToPrograms(best.id, [programId], episodes, showTitles);

    // Spread to siblings sharing the same normalized title that are still
    // unmatched — same cohort behaviour as `linkProgram`.
    const candidates = await db
      .select({ id: programs.id, title: programs.title })
      .from(programs)
      .where(and(isNull(programs.tvdbId), ne(programs.id, programId)));
    const ids = candidates
      .filter((r) => normalizeTitle(r.title) === key)
      .map((r) => r.id);
    if (ids.length > 0) {
      await this.applyTvdbToPrograms(best.id, ids, episodes, showTitles);
    }

    this.hits++;
    return best;
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
