import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import type { Program } from '../schemas/program.ts';
import { db } from '../db/client.ts';
import { programs, tvdbEntries } from '../db/schema.ts';
import { genreFromKey } from '../lib/genreRegistry.ts';
import { tvdbRowToEntry } from './ruleService.ts';

type ProgramRow = typeof programs.$inferSelect;
type TvdbRow = typeof tvdbEntries.$inferSelect;

function rowToProgram(row: ProgramRow, tvdb: TvdbRow | null): Program {
  const p: Program = {
    id: row.id,
    ch: row.ch,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    title: row.title,
    genre: genreFromKey(row.genreKey),
    ep: row.ep,
    series: row.series,
    hd: row.hd,
  };
  if (row.desc != null) p.desc = row.desc;
  if (row.extended != null && Object.keys(row.extended).length > 0) p.extended = row.extended;
  if (row.video != null) p.video = row.video;
  if (tvdb) p.tvdb = tvdbRowToEntry(tvdb);
  if (row.tvdbSeason != null) p.tvdbSeason = row.tvdbSeason;
  if (row.tvdbEpisode != null) p.tvdbEpisode = row.tvdbEpisode;
  if (row.tvdbEpisodeName != null) p.tvdbEpisodeName = row.tvdbEpisodeName;
  return p;
}

export interface ProgramService {
  /** All programs from DB joined with their TVDB entry. Sorted by startAt. */
  list(): Promise<Program[]>;
  /** One program by id, or null. */
  findById(id: string): Promise<Program | null>;
  /** Programs whose time window intersects [startMs, endMs). */
  listInRange(startMs: number, endMs: number): Promise<Program[]>;
  /** Bulk upsert from a live EPG feed. Programs not in input are left alone
   *  (ttl cleanup is separate) so an empty feed doesn't nuke the table. */
  upsertMany(list: Program[]): Promise<void>;
  /** Assign a TVDB entry to a program (e.g. from the auto-matcher). */
  setTvdbMatch(programId: string, tvdbId: number | null): Promise<void>;
  /** Clear matches older than windowMs — used when re-fetching full day. */
  prunePast(beforeMs: number): Promise<number>;
}

class DrizzleProgramService implements ProgramService {
  async list(): Promise<Program[]> {
    const rows = await db
      .select({ p: programs, t: tvdbEntries })
      .from(programs)
      .leftJoin(tvdbEntries, eq(programs.tvdbId, tvdbEntries.tvdbId))
      .orderBy(asc(programs.startAt));
    return rows.map((r) => rowToProgram(r.p, r.t));
  }

  async findById(id: string): Promise<Program | null> {
    const [row] = await db
      .select({ p: programs, t: tvdbEntries })
      .from(programs)
      .leftJoin(tvdbEntries, eq(programs.tvdbId, tvdbEntries.tvdbId))
      .where(eq(programs.id, id))
      .limit(1);
    return row ? rowToProgram(row.p, row.t) : null;
  }

  async listInRange(startMs: number, endMs: number): Promise<Program[]> {
    // Strict "start-in-range" — a program belongs to this window only if
    // its startAt falls inside [start, end). This matches Japanese 放送日
    // semantics (05:00 boundary) where a 04:00 JST show belongs to the
    // PREVIOUS 放送日, not the calendar day. Overlap semantics leaked
    // 30-minute programs ending just after 05:00 into the next day.
    const startIso = new Date(startMs);
    const endIso = new Date(endMs);
    const rows = await db
      .select({ p: programs, t: tvdbEntries })
      .from(programs)
      .leftJoin(tvdbEntries, eq(programs.tvdbId, tvdbEntries.tvdbId))
      .where(and(gt(programs.startAt, new Date(startMs - 1)), lt(programs.startAt, endIso)))
      .orderBy(asc(programs.startAt));
    return rows.map((r) => rowToProgram(r.p, r.t));
  }

  async upsertMany(list: Program[]): Promise<void> {
    if (list.length === 0) return;
    // Chunk to stay under Postgres' bind-parameter limit (<= 65535).
    // Each row binds ~10 params, so 500/batch is safe.
    const CHUNK = 500;
    for (let i = 0; i < list.length; i += CHUNK) {
      const slice = list.slice(i, i + CHUNK);
      const values = slice.map((p) => ({
        id: p.id,
        ch: p.ch,
        startAt: new Date(p.startAt),
        endAt: new Date(p.endAt),
        title: p.title,
        genreKey: p.genre.key,
        ep: p.ep ?? null,
        series: p.series ?? null,
        hd: p.hd ?? false,
        desc: p.desc ?? null,
        extended: p.extended ?? null,
        video: p.video ?? null,
      }));
      await db
        .insert(programs)
        .values(values)
        .onConflictDoUpdate({
          target: programs.id,
          // Update everything except tvdbId/tvdbMatchedAt — those are owned by
          // the matcher and persist across EPG refreshes. Title may change
          // (program rename / extension) so we overwrite it.
          set: {
            ch: sql`excluded.ch`,
            startAt: sql`excluded.start_at`,
            endAt: sql`excluded.end_at`,
            title: sql`excluded.title`,
            genreKey: sql`excluded.genre_key`,
            ep: sql`excluded.ep`,
            series: sql`excluded.series`,
            hd: sql`excluded.hd`,
            desc: sql`excluded.desc`,
            extended: sql`excluded.extended`,
            video: sql`excluded.video`,
          },
        });
    }
  }

  async setTvdbMatch(programId: string, tvdbId: number | null): Promise<void> {
    await db
      .update(programs)
      .set({ tvdbId, tvdbMatchedAt: tvdbId != null ? new Date() : null })
      .where(eq(programs.id, programId));
  }

  async prunePast(beforeMs: number): Promise<number> {
    const rows = await db
      .delete(programs)
      .where(lt(programs.endAt, new Date(beforeMs)))
      .returning({ id: programs.id });
    return rows.length;
  }
}

export const programService: ProgramService = new DrizzleProgramService();
