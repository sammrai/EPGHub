import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { programs, rankings, tvdbEntries } from '../db/schema.ts';
import { tvdbService } from './tvdbService.ts';
import { normalizeTitle } from './matchService.ts';
import { tvdbRowToEntry } from './ruleService.ts';
import { fetchJcomRanking, type JcomGenreId, type JcomRankingRow } from '../integrations/jcom/client.ts';
import type { TvdbEntry } from '../schemas/tvdb.ts';
import type { RankingGenre, RankingItem, RankingList } from '../schemas/ranking.ts';

// -----------------------------------------------------------------
// Ranking service
// -----------------------------------------------------------------
// syncAll() replaces every genre's snapshot (global 'all' + per-genre). We
// truncate-by-genre rather than globally so if one genre fetch fails, the
// others' last-known snapshots survive.
//
// list() joins rankings × tvdb_entries and returns the rows in rank order.
// The matcher populates tvdbId inline during sync so the UI can render a
// poster without a second query.

// Internal-key ('all', 'movie', 'drama' ...) → JCOM genreId (hex char | null).
// 'all' uses the empty-genre JCOM query. Each ARIB key we care about maps to
// exactly one JCOM hex id (劇場 is the exception: we prefer the 8=doc id so
// the 'doc' bucket shows documentaries, not stage plays).
const GENRE_TO_JCOM: Record<RankingGenre, JcomGenreId | null> = {
  all:   null,
  movie: '6',
  drama: '3',
  sport: '1',
  anime: '7',
  music: '4',
  var:   '5',
  doc:   '8',
  edu:   'A',
};

// -----------------------------------------------------------------
// Matching helpers — same scoring shape as matchService. Duplicated here to
// avoid exporting internal scoring from matchService (tight coupling risk).
// -----------------------------------------------------------------

function scoreEntry(e: TvdbEntry, key: string): number {
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

function pickBest(hits: TvdbEntry[], key: string): TvdbEntry | null {
  const ranked = hits
    .map((e) => ({ e, s: scoreEntry(e, key) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s);
  return ranked[0]?.e ?? null;
}

// Tiny in-memory cache so syncAll() doesn't re-issue the same TVDB search
// for titles that repeat across genre boards.
const matchCache = new Map<string, TvdbEntry | null>();

async function resolveTvdbId(title: string): Promise<number | null> {
  const key = normalizeTitle(title);
  if (!key) return null;
  if (matchCache.has(key)) return matchCache.get(key)?.id ?? null;
  try {
    const hits = await tvdbService.search(key);
    const best = pickBest(hits, key);
    matchCache.set(key, best);
    if (!best) return null;
    // Persist so the listing join finds a row.
    await upsertTvdbEntry(best);
    return best.id;
  } catch (err) {
    console.warn('[ranking] tvdb search failed for', key, (err as Error).message);
    matchCache.set(key, null);
    return null;
  }
}

async function upsertTvdbEntry(entry: TvdbEntry): Promise<void> {
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
    currentEp:    entry.type === 'series' ? entry.currentEp    : null,
    totalEps:     entry.type === 'series' ? entry.totalEps     : null,
    status:       entry.type === 'series' ? entry.status       : null,
    runtime:  entry.type === 'movie' ? entry.runtime  : null,
    director: entry.type === 'movie' ? entry.director : null,
    rating:   entry.type === 'movie' ? entry.rating   : null,
    updatedAt: new Date(),
  };
  await db
    .insert(tvdbEntries)
    .values(base)
    .onConflictDoUpdate({
      target: tvdbEntries.tvdbId,
      set: {
        slug: base.slug, kind: base.kind, title: base.title, titleEn: base.titleEn,
        network: base.network, year: base.year, poster: base.poster, matchedBy: base.matchedBy,
        totalSeasons: base.totalSeasons, currentSeason: base.currentSeason,
        currentEp: base.currentEp, totalEps: base.totalEps, status: base.status,
        runtime: base.runtime, director: base.director, rating: base.rating,
        updatedAt: base.updatedAt,
      },
    });
}

// -----------------------------------------------------------------
// Row shaping
// -----------------------------------------------------------------

function deltaFrom(prevRank: string | undefined, rank: number): number | null {
  if (!prevRank || prevRank.length === 0) return null;
  const prev = Number(prevRank);
  if (!Number.isFinite(prev)) return null;
  return prev - rank;
}

function channelOf(row: JcomRankingRow): string | null {
  return row.nextBroadcast?.[0]?.channelName ?? null;
}

function quoteOf(row: JcomRankingRow): string | null {
  return row.nextBroadcast?.[0]?.nextTitle ?? null;
}

// Channel-name fuzzy matching between JCOM ("TBS", "NHK東京 総合") and
// Mirakurun ("MBS 毎日放送", "NHK総合１・大阪") is unreliable because the
// two feeds broadcast different regional affiliates. We bridge via TVDB
// instead: the ranking row's `tvdbId` (already matched at sync time) is
// looked up in our `programs` table for the next upcoming airing on any
// channel the local tuner actually sees. If no such program exists
// (user doesn't receive any affiliate of that TVDB entry) we return
// null and the frontend simply doesn't render the clickable link. See
// the batched resolver in list() below; keeping a single-lookup helper
// here for callers that only need one.
async function nextProgramIdForTvdb(tvdbId: number | null | undefined): Promise<string | null> {
  if (tvdbId == null) return null;
  const now = new Date();
  const rows = await db
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.tvdbId, tvdbId), gt(programs.startAt, now)))
    .orderBy(asc(programs.startAt))
    .limit(1);
  return rows[0]?.id ?? null;
}
// Keep export surface clean — single-row variant isn't used in hot paths
// today but is handy for admin debug / future features.
export { nextProgramIdForTvdb };

// -----------------------------------------------------------------
// Public API
// -----------------------------------------------------------------

export interface RankingService {
  /** Fetch every genre board from JCOM, match titles to TVDB, replace snapshots. */
  syncAll(): Promise<{ genres: number; rows: number }>;
  /** Return rows for a genre (or 'all'), ordered by rank asc. */
  list(genre: RankingGenre): Promise<RankingList>;
}

class DrizzleRankingService implements RankingService {
  async syncAll(): Promise<{ genres: number; rows: number }> {
    const now = new Date();
    let totalRows = 0;
    let genresSynced = 0;

    // Each entry is a (internal-key, jcom-hex-id) pair. 'all' is first so the
    // global board is always up to date even if a per-genre call fails.
    const entries: Array<{ key: RankingGenre; jcomId: JcomGenreId | null }> = [
      { key: 'all', jcomId: null },
      ...(Object.entries(GENRE_TO_JCOM)
        .filter(([k]) => k !== 'all')
        .map(([k, v]) => ({ key: k as RankingGenre, jcomId: v }))),
    ];

    for (const { key, jcomId } of entries) {
      const rows = await fetchJcomRanking({ genreId: jcomId });
      if (rows.length === 0) {
        console.warn(`[ranking] ${key} fetch returned no rows; keeping previous snapshot`);
        continue;
      }

      // Resolve tvdb match per title (cache shared across genres).
      const resolved = await Promise.all(
        rows.map(async (r, i) => {
          const rank = i + 1;
          const tvdbId = await resolveTvdbId(r.title);
          return { r, rank, tvdbId };
        })
      );

      // Replace-per-genre: delete old snapshot then insert the new one in a
      // transaction so /rankings never sees a partial board.
      await db.transaction(async (tx) => {
        await tx.delete(rankings).where(eq(rankings.genreId, key));
        if (resolved.length === 0) return;
        await tx.insert(rankings).values(
          resolved.map(({ r, rank, tvdbId }) => ({
            genreId:     key,
            rank,
            title:       r.title,
            channelName: channelOf(r),
            delta:       deltaFrom(r.prevRank, rank),
            quote:       quoteOf(r),
            jcomData:    r as unknown as Record<string, unknown>,
            tvdbId:      tvdbId,
            syncedAt:    now,
          }))
        );
      });

      totalRows += resolved.length;
      genresSynced += 1;
    }

    // Clear the per-run match cache so the next sync doesn't hold onto stale
    // TVDB data forever.
    matchCache.clear();

    return { genres: genresSynced, rows: totalRows };
  }

  async list(genre: RankingGenre): Promise<RankingList> {
    const rows = await db
      .select({ r: rankings, t: tvdbEntries })
      .from(rankings)
      .leftJoin(tvdbEntries, eq(rankings.tvdbId, tvdbEntries.tvdbId))
      .where(eq(rankings.genreId, genre))
      .orderBy(asc(rankings.rank));

    // Resolve nextProgramId via TVDB bridge: ranking.tvdbId → programs
    // table next airing. Do one batched lookup (single SQL) instead of
    // N round-trips.
    const tvdbIds = Array.from(
      new Set(rows.map(({ r }) => r.tvdbId).filter((id): id is number => id != null))
    );
    const nextByTvdb = new Map<number, string>();
    if (tvdbIds.length > 0) {
      const now = new Date();
      // Pull every future program matching any of the ranking tvdbIds in
      // one shot, ordered by startAt, then take the first per tvdbId in JS.
      // Avoids a PG array-cast that the `postgres` driver doesn't emit
      // cleanly when passing a JS number[].
      const nextRows = await db
        .select({ id: programs.id, tvdbId: programs.tvdbId, startAt: programs.startAt })
        .from(programs)
        .where(and(inArray(programs.tvdbId, tvdbIds), gt(programs.startAt, now)))
        .orderBy(asc(programs.startAt));
      for (const nr of nextRows) {
        if (nr.tvdbId != null && !nextByTvdb.has(nr.tvdbId)) {
          nextByTvdb.set(nr.tvdbId, nr.id);
        }
      }
    }

    const items: RankingItem[] = rows.map(({ r, t }) => {
      const nextProgramId = r.tvdbId != null ? nextByTvdb.get(r.tvdbId) : undefined;
      return {
        rank:        r.rank,
        title:       r.title,
        channelName: r.channelName,
        delta:       r.delta,
        quote:       r.quote,
        ...(nextProgramId ? { nextProgramId } : {}),
        tvdb:        t ? tvdbRowToEntry(t) : null,
        syncedAt:    r.syncedAt.toISOString(),
      };
    });

    return { genre, items };
  }
}

export const rankingService: RankingService = new DrizzleRankingService();
