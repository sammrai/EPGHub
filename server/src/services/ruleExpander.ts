import { eq } from 'drizzle-orm';
import type { Program } from '../schemas/program.ts';
import type { Rule } from '../schemas/rule.ts';
import { ruleService } from './ruleService.ts';
import { scheduleService } from './scheduleService.ts';
import { recordingService, RecordingConflictError } from './recordingService.ts';
import { recordedHistoryService } from './recordedHistoryService.ts';
import { db } from '../db/client.ts';
import { rules as rulesTable } from '../db/schema.ts';

export interface ExpandSummary {
  matchedPrograms: number;
  createdRecordings: number;
  conflicts: {
    duplicate: number;
    tunerFull: number;
    // Existing lower-priority recordings that the allocator demoted to
    // state='conflict' when a higher-priority rule match took their slot
    // during this expansion run.
    preempted: number;
  };
}

const RERUN_MARKERS = ['再', '(再)', '[再]'];

// Minimal title normalizer for the tvdb-title fallback: strip bracketed
// qualifiers and rerun markers, collapse whitespace, lower-case.
// Exported so recorder.stopRecording() can write history rows with the
// same key shape ruleExpander will look them up by — the two sides must
// agree on normalization or dedupe silently misses.
export function normalizeTitle(t: string): string {
  return t
    .replace(/[\(（\[【][^\)）\]】]*[\)）\]】]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isRerun(title: string): boolean {
  return RERUN_MARKERS.some((m) => title.includes(m));
}

/**
 * Return the JST "HH:MM" wall clock string for a Date. Uses the fixed
 * Asia/Tokyo offset (+09:00) rather than the host TZ so tests and
 * production agree regardless of where the process runs.
 */
function jstHHMM(d: Date): string {
  // +09:00 offset is a constant for Japan — no DST — so we can hand-roll
  // instead of pulling Intl.DateTimeFormat (~10x slower per call).
  const ms = d.getTime() + 9 * 60 * 60 * 1000;
  const u = new Date(ms);
  const h = String(u.getUTCHours()).padStart(2, '0');
  const m = String(u.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Broadcast-day hours in Japan extend past midnight: the 01:00 JST airing
 * of a late-night show is conventionally expressed as "25:00" because it
 * belongs to the previous calendar day's programming block. Return HH:MM
 * in that notation — if the JST hour is 0–4, shift it by +24 so the
 * string carries the broadcast-day hour (25..28 for 01..04, plus 24 for
 * 00).
 *
 * Pairs with `parseBroadcastMinutes` below: the rule's user-typed
 * boundaries (e.g. "25:00"–"29:00") are parsed with the same convention,
 * so comparisons in `inTimeRange` happen in a single "minutes since
 * broadcast-day 00:00" number line from 0 to 1799.
 */
function jstBroadcastHHMM(d: Date): string {
  const ms = d.getTime() + 9 * 60 * 60 * 1000;
  const u = new Date(ms);
  const rawH = u.getUTCHours();
  const h = rawH <= 4 ? rawH + 24 : rawH;
  const m = String(u.getUTCMinutes()).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${m}`;
}

/**
 * Parse a broadcast-day HH:MM string into minutes-since-broadcast-00:00.
 * Accepts hours 00..29 so "28:30" → (24+4)*60 + 30 = 1710.
 */
function parseBroadcastMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  return h * 60 + m;
}

/**
 * True iff `hhmm` falls within `[start, end)`. All three arguments are
 * interpreted as broadcast-day HH:MM (hours 00..29) — the minute scale
 * is 0..1799. Ranges where start > end (e.g. 26:00–05:00, vanishingly
 * rare in broadcast notation but still possible if a user types a
 * wrapping calendar-clock range) are supported via the same split-union
 * trick as before.
 */
function inTimeRange(hhmm: string, start: string, end: string): boolean {
  if (start === end) return false;
  const t = parseBroadcastMinutes(hhmm);
  const s = parseBroadcastMinutes(start);
  const e = parseBroadcastMinutes(end);
  if (s < e) return t >= s && t < e;
  // wrap
  return t >= s || t < e;
}

/**
 * Pure rule-match predicate. Exported so unit tests can exercise the
 * exclusion matrix without a DB. No side effects, no service calls —
 * the (rule, program, now) tuple is all the signal it uses.
 *
 * Evaluation order matters for test coverage:
 *   1. Past program / rerun                 — existing gates
 *   2. kind-specific base match (series/keyword)
 *   3. ngKeywords — any title substring hit → deny
 *   4. genreDeny — program genre key hit   → deny
 *   5. timeRangeDeny — JST start hh:mm hit → deny
 *
 * Exclusions are applied *after* the base match passes so a rule with
 * nothing in the deny lists behaves exactly as it did pre-Phase-7.
 */
export function rulePredicate(rule: Rule, program: Program, nowMs: number): boolean {
  // Skip programs already ended.
  if (Date.parse(program.endAt) < nowMs) return false;
  // Skip reruns if requested.
  if (rule.skipReruns && isRerun(program.title)) return false;

  let baseMatch: boolean;
  if (rule.kind === 'series') {
    if (!rule.tvdb) return false;
    // Prefer structured match if the program carries a tvdb entry.
    if (program.tvdb && program.tvdb.id === rule.tvdb.id) {
      baseMatch = true;
    } else if (!program.tvdb) {
      // Fallback: naive normalized-title compare. Don't match if the program
      // has a tvdb entry pointing at a different id (prevents the title-compare
      // from overriding a confident mismatch).
      baseMatch = normalizeTitle(rule.tvdb.title) === normalizeTitle(program.title);
    } else {
      baseMatch = false;
    }
  } else {
    // keyword (default)
    if (!program.title.includes(rule.keyword)) return false;
    if (rule.channels.length > 0 && !rule.channels.includes(program.ch)) return false;
    baseMatch = true;
  }

  if (!baseMatch) return false;

  // --- Exclusions (Phase 7) -------------------------------------------
  // Ported from EPGStation's ReserveOptionChecker shape, but we only port
  // the predicates — our rule surface doesn't include the regex/cs flags.

  const ngKeywords = rule.ngKeywords ?? [];
  for (const ng of ngKeywords) {
    if (!ng) continue;
    if (program.title.includes(ng)) return false;
  }

  const genreDeny = rule.genreDeny ?? [];
  if (genreDeny.length > 0 && genreDeny.includes(program.genre.key)) {
    return false;
  }

  const timeRangeDeny = rule.timeRangeDeny ?? [];
  if (timeRangeDeny.length > 0) {
    const hhmm = jstBroadcastHHMM(new Date(program.startAt));
    for (const range of timeRangeDeny) {
      if (inTimeRange(hhmm, range.start, range.end)) return false;
    }
  }

  return true;
}

// Back-compat local alias so the rest of the module keeps its call shape.
// Kept private; tests import `rulePredicate` directly.
function matches(rule: Rule, program: Program, nowMs: number): boolean {
  return rulePredicate(rule, program, nowMs);
}

export async function expandRules(): Promise<ExpandSummary> {
  const [rules, programs] = await Promise.all([ruleService.list(), scheduleService.list()]);
  const enabled = rules.filter((r) => r.enabled);
  const nowMs = Date.now();

  const summary: ExpandSummary = {
    matchedPrograms: 0,
    createdRecordings: 0,
    conflicts: { duplicate: 0, tunerFull: 0, preempted: 0 },
  };

  // Snapshot conflict-state recordings before expansion so we can count how
  // many new ones appear as a side-effect of preemption.
  const beforeConflict = new Set(
    (await recordingService.list({ state: 'conflict' })).map((r) => r.id)
  );

  for (const rule of enabled) {
    // Collect matches in chronological order so we can stamp rule.nextMatch
    // with the earliest future airing once we've seen them all. Without this
    // step the Rules tab never shows "次回" — the column defaults to null
    // at rule create time and nothing would backfill it.
    const ruleMatches: Program[] = [];
    for (const program of programs) {
      if (!matches(rule, program, nowMs)) continue;
      ruleMatches.push(program);
      summary.matchedPrograms += 1;
      // Phase 4 dedupe: before we try to create a reserve, ask the recorded-
      // history ledger whether we've already recorded this episode. Only
      // fires when the rule opts into it — a user who clears skipReruns
      // presumably wants every airing. We derive the match key the same
      // way recorder.stopRecording writes it (tvdb tuple preferred,
      // normalizedTitle+endAt fallback) so the two sides agree on identity.
      if (rule.skipReruns) {
        const hasTvdbTuple =
          program.tvdb?.id != null &&
          program.tvdbSeason != null &&
          program.tvdbEpisode != null;
        const alreadyRecorded = await recordedHistoryService.has(
          hasTvdbTuple
            ? {
                tvdbId: program.tvdb!.id,
                season: program.tvdbSeason!,
                episode: program.tvdbEpisode!,
                endAt: new Date(program.endAt),
              }
            : {
                normalizedTitle: normalizeTitle(program.title),
                endAt: new Date(program.endAt),
              }
        );
        if (alreadyRecorded) {
          summary.conflicts.duplicate += 1;
          continue;
        }
      }
      try {
        await recordingService.create({
          programId: program.id,
          priority: rule.priority,
          quality: rule.quality,
          keepRaw: false,
          marginPre: 0,
          marginPost: 30,
          source:
            rule.kind === 'series'
              ? { kind: 'series', tvdbId: rule.tvdb!.id }
              : { kind: 'rule', ruleId: rule.id },
          force: false,
        });
        summary.createdRecordings += 1;
      } catch (err) {
        if (err instanceof RecordingConflictError && err.reason === 'duplicate') {
          summary.conflicts.duplicate += 1;
          continue;
        }
        if (err instanceof RecordingConflictError && err.reason === 'tuner-full') {
          summary.conflicts.tunerFull += 1;
          continue;
        }
        throw err;
      }
    }
    // Earliest upcoming airing for this rule → write to rules row. This
    // drives the "次回 HH:MM · タイトル" badge in RuleCard/SeriesRuleCard.
    const earliest = ruleMatches.reduce<Program | null>((a, b) => {
      if (!a) return b;
      return Date.parse(b.startAt) < Date.parse(a.startAt) ? b : a;
    }, null);
    await db
      .update(rulesTable)
      .set({
        nextMatchCh: earliest?.ch ?? null,
        nextMatchTitle: earliest?.title ?? null,
        nextMatchAt: earliest ? new Date(earliest.startAt) : null,
        matches: ruleMatches.length,
      })
      .where(eq(rulesTable.id, rule.id));
  }

  // Count recordings newly in 'conflict' that weren't before — those are the
  // ones the allocator preempted during this run.
  const afterConflict = await recordingService.list({ state: 'conflict' });
  summary.conflicts.preempted = afterConflict.filter((r) => !beforeConflict.has(r.id)).length;

  return summary;
}
