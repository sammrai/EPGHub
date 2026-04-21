import { and, desc, eq, gte, lte, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { recordedHistory, recordings } from '../db/schema.ts';

// -----------------------------------------------------------------
// Recorded-history service — dedupe ledger the rule expander consults
// before creating a new reserve. Append-only; never update rows. Two
// match strategies in order of confidence:
//
//   1. Structured tvdb tuple (tvdbId + season + episode) — when the
//      program resolved to a TVDB entry with a season/episode pair.
//      Exact 3-tuple match, guaranteed unique by schema.
//
//   2. normalizedTitle + endAt ± TITLE_FUZZY_WINDOW_MS — used when
//      tvdbId is null or the TVDB lookup didn't land on an episode
//      number (e.g. a weekly variety program with no episode list).
//      The ± window absorbs tiny schedule shifts (EIT extensions,
//      small timezone rounding) so the "same episode on a different
//      channel half an hour later" path still hits.
//
// The service is intentionally thin: the predicate logic lives here
// so both ruleExpander (ask) and recorder (insert) share the same
// key derivation without duplicating normalization code.
// -----------------------------------------------------------------

export interface HistoryKey {
  /** TVDB series id. Null when the program didn't resolve. */
  tvdbId?: number | null;
  /** TVDB season number (aired order). */
  season?: number | null;
  /** TVDB episode number (aired order). */
  episode?: number | null;
  /** Pre-normalized title. Caller-owned normalization. */
  normalizedTitle?: string | null;
  /** Program endAt timestamp. Used as the anchor for fuzzy matching. */
  endAt: Date;
}

export interface RecordedHistoryRow {
  id: number;
  tvdbId: number | null;
  season: number | null;
  episode: number | null;
  normalizedTitle: string | null;
  endAt: string;
  createdAt: string;
}

// ±2h around the program's endAt. Chosen to cover channel-wide extension
// events (24h EIT sweeps) without being so wide that a weekly show on the
// same day of week at a different hour accidentally hits.
const TITLE_FUZZY_WINDOW_MS = 2 * 60 * 60 * 1000;

type HistoryRow = typeof recordedHistory.$inferSelect;

function rowToHistory(row: HistoryRow): RecordedHistoryRow {
  return {
    id: row.id,
    tvdbId: row.tvdbId,
    season: row.season,
    episode: row.episode,
    normalizedTitle: row.normalizedTitle,
    endAt: row.endAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RecordedHistoryService {
  has(key: HistoryKey): Promise<boolean>;
  insert(key: HistoryKey): Promise<void>;
  rebuildFromRecorded(): Promise<{ inserted: number }>;
  list(opts?: { tvdbId?: number; limit?: number }): Promise<RecordedHistoryRow[]>;
}

export class DrizzleRecordedHistoryService implements RecordedHistoryService {
  async has(key: HistoryKey): Promise<boolean> {
    // Path 1: structured tvdb tuple. Exact 3-tuple match is cheap and
    // unambiguous — if we have all three ids, trust them and skip the
    // fuzzy fallback entirely.
    if (
      key.tvdbId != null &&
      key.season != null &&
      key.episode != null
    ) {
      const [hit] = await db
        .select({ id: recordedHistory.id })
        .from(recordedHistory)
        .where(
          and(
            eq(recordedHistory.tvdbId, key.tvdbId),
            eq(recordedHistory.season, key.season),
            eq(recordedHistory.episode, key.episode)
          )
        )
        .limit(1);
      return hit != null;
    }

    // Path 2: fuzzy title + endAt window. Only fires when there's no
    // structured key. A very old history row that happens to share a
    // common title will not collide because endAt narrows it down.
    if (key.normalizedTitle) {
      const lo = new Date(key.endAt.getTime() - TITLE_FUZZY_WINDOW_MS);
      const hi = new Date(key.endAt.getTime() + TITLE_FUZZY_WINDOW_MS);
      const [hit] = await db
        .select({ id: recordedHistory.id })
        .from(recordedHistory)
        .where(
          and(
            eq(recordedHistory.normalizedTitle, key.normalizedTitle),
            gte(recordedHistory.endAt, lo),
            lte(recordedHistory.endAt, hi)
          )
        )
        .limit(1);
      return hit != null;
    }

    return false;
  }

  async insert(key: HistoryKey): Promise<void> {
    // Idempotent on the tvdb tuple via the partial unique index. The
    // title-fallback branch relies on the caller (recorder.stopRecording)
    // firing exactly once per recording — there's no natural unique key
    // we can enforce without over-constraining legitimately-identical
    // reruns.
    try {
      await db.insert(recordedHistory).values({
        tvdbId: key.tvdbId ?? null,
        season: key.season ?? null,
        episode: key.episode ?? null,
        normalizedTitle: key.normalizedTitle ?? null,
        endAt: key.endAt,
      });
    } catch (err) {
      // Unique violation on (tvdbId, season, episode) is fine — the row
      // already exists, which is exactly the state we want. Re-throw
      // anything else so upstream sees the failure.
      const code = (err as { code?: string })?.code;
      if (code === '23505') return;
      throw err;
    }
  }

  async rebuildFromRecorded(): Promise<{ inserted: number }> {
    // Seed the history table from existing recordings in a completed
    // state (ready/failed) so the dedupe ledger reflects everything we
    // actually captured. Only structured (tvdb) keys + title fallback;
    // scheduled/conflict rows never aired, so we skip them.
    const rows = await db
      .select({
        tvdbId: recordings.tvdbId,
        season: recordings.season,
        episode: recordings.ep,
        title: recordings.title,
        recordedAt: recordings.recordedAt,
        duration: recordings.duration,
        endAt: recordings.endAt,
        state: recordings.state,
      })
      .from(recordings);

    let inserted = 0;
    for (const r of rows) {
      if (r.state !== 'ready' && r.state !== 'failed') continue;
      // Prefer the planned endAt; fall back to recordedAt + duration.
      const endAt = r.endAt
        ?? (r.recordedAt
              ? new Date(r.recordedAt.getTime() + (r.duration ?? 0) * 60_000)
              : null);
      if (!endAt) continue;
      try {
        await db.insert(recordedHistory).values({
          tvdbId: r.tvdbId ?? null,
          season: r.season ?? null,
          episode: r.episode ?? null,
          normalizedTitle: r.title,
          endAt,
        });
        inserted += 1;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === '23505') continue;
        throw err;
      }
    }
    return { inserted };
  }

  async list(opts: { tvdbId?: number; limit?: number } = {}): Promise<RecordedHistoryRow[]> {
    const limit = opts.limit ?? 200;
    const rows =
      opts.tvdbId != null
        ? await db
            .select()
            .from(recordedHistory)
            .where(
              and(
                isNotNull(recordedHistory.tvdbId),
                eq(recordedHistory.tvdbId, opts.tvdbId)
              )
            )
            .orderBy(desc(recordedHistory.createdAt))
            .limit(limit)
        : await db
            .select()
            .from(recordedHistory)
            .orderBy(desc(recordedHistory.createdAt))
            .limit(limit);
    return rows.map(rowToHistory);
  }
}

export const recordedHistoryService: RecordedHistoryService =
  new DrizzleRecordedHistoryService();
