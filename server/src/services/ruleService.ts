import { and, asc, eq } from 'drizzle-orm';
import type { Rule } from '../schemas/rule.ts';
import type { TvdbEntry } from '../schemas/tvdb.ts';
import { z } from '@hono/zod-openapi';
import { CreateRuleSchema, UpdateRuleSchema } from '../schemas/rule.ts';
import { db } from '../db/client.ts';
import { rules, tvdbEntries } from '../db/schema.ts';

/**
 * Thrown when a rule create/update would create a semantic duplicate.
 * Routes translate this to HTTP 409 with `code: 'rule.duplicate'`.
 *
 * Currently fires for:
 *  - A second series rule (kind='series') with the same tvdbId — a series is
 *    uniquely identified by its TVDB id; a second rule would just generate
 *    duplicate reserves.
 */
export class RuleConflictError extends Error {
  constructor(
    public readonly reason: 'duplicate',
    public readonly detail: Record<string, unknown> = {}
  ) {
    super(reason);
  }
}

export interface RuleService {
  list(): Promise<Rule[]>;
  findById(id: number): Promise<Rule | null>;
  create(input: z.infer<typeof CreateRuleSchema>): Promise<Rule>;
  update(id: number, input: z.infer<typeof UpdateRuleSchema>): Promise<Rule | null>;
  remove(id: number): Promise<boolean>;
}

type RuleRow = typeof rules.$inferSelect;
type TvdbRow = typeof tvdbEntries.$inferSelect;

export function tvdbRowToEntry(row: TvdbRow): TvdbEntry {
  const base = {
    id: row.tvdbId,
    slug: row.slug,
    title: row.title,
    titleEn: row.titleEn,
    network: row.network,
    year: row.year,
    poster: row.poster,
    matchedBy: row.matchedBy,
  };
  if (row.kind === 'movie') {
    return {
      ...base,
      type: 'movie',
      runtime: row.runtime ?? 0,
      director: row.director ?? '',
      rating: row.rating ?? 0,
    };
  }
  return {
    ...base,
    type: 'series',
    totalSeasons: row.totalSeasons ?? 0,
    currentSeason: row.currentSeason ?? 0,
    currentEp: row.currentEp ?? 0,
    totalEps: row.totalEps ?? 0,
    status: (row.status as 'continuing' | 'ended') ?? 'continuing',
  };
}

// DB row → API DTO: combines the rules row with an optional tvdb_entries
// join so consumers get the nested TVDB object without a follow-up fetch.
function rowToRule(row: RuleRow, tvdb: TvdbRow | null): Rule {
  const nextMatch =
    row.nextMatchCh && row.nextMatchTitle && row.nextMatchAt
      ? {
          ch: row.nextMatchCh,
          title: row.nextMatchTitle,
          at: row.nextMatchAt.toISOString(),
        }
      : null;
  const base: Rule = {
    id: row.id,
    name: row.name,
    keyword: row.keyword,
    channels: row.channels,
    enabled: row.enabled,
    matches: row.matches,
    nextMatch,
    priority: row.priority as Rule['priority'],
    quality: row.quality as Rule['quality'],
    skipReruns: row.skipReruns,
    kind: row.kind as Rule['kind'],
    // Exclusion lists: DB columns are nullable jsonb; rule expander/UI both
    // want empty arrays on absence. Normalize here so no caller has to
    // repeat the `?? []` incantation.
    ngKeywords:    row.ngKeywords ?? [],
    genreDeny:     row.genreDeny ?? [],
    timeRangeDeny: row.timeRangeDeny ?? [],
  };
  if (tvdb) base.tvdb = tvdbRowToEntry(tvdb);
  return base;
}

export class DrizzleRuleService implements RuleService {
  async list(): Promise<Rule[]> {
    const rows = await db
      .select({ rule: rules, tvdb: tvdbEntries })
      .from(rules)
      .leftJoin(tvdbEntries, eq(rules.tvdbId, tvdbEntries.tvdbId))
      .orderBy(asc(rules.id));
    return rows.map((r) => rowToRule(r.rule, r.tvdb));
  }

  async findById(id: number): Promise<Rule | null> {
    const [row] = await db
      .select({ rule: rules, tvdb: tvdbEntries })
      .from(rules)
      .leftJoin(tvdbEntries, eq(rules.tvdbId, tvdbEntries.tvdbId))
      .where(eq(rules.id, id))
      .limit(1);
    return row ? rowToRule(row.rule, row.tvdb) : null;
  }

  async create(input: z.infer<typeof CreateRuleSchema>): Promise<Rule> {
    // Reject a second series rule for the same TVDB series. A series rule
    // is a pin to a TVDB id; a second rule would just race the first in
    // rule.expand and create conflicting reserves.
    if (input.kind === 'series' && input.tvdb?.id != null) {
      const existing = await db
        .select({ id: rules.id })
        .from(rules)
        .where(and(eq(rules.kind, 'series'), eq(rules.tvdbId, input.tvdb.id)))
        .limit(1);
      if (existing.length > 0) {
        throw new RuleConflictError('duplicate', {
          existingRuleId: existing[0].id,
          tvdbId: input.tvdb.id,
        });
      }
    }

    const [inserted] = await db
      .insert(rules)
      .values({
        name: input.name,
        keyword: input.keyword,
        channels: input.channels ?? [],
        enabled: input.enabled ?? true,
        matches: 0,
        nextMatchCh: null,
        nextMatchTitle: null,
        nextMatchAt: null,
        priority: input.priority ?? 'medium',
        quality: input.quality ?? '1080i',
        skipReruns: input.skipReruns ?? true,
        kind: input.kind ?? 'keyword',
        tvdbId: input.tvdb?.id ?? null,
        // Persist exclusion lists only when the caller actually supplied
        // them. Leaving the column NULL on creation lets us distinguish
        // "never set" from "explicitly empty" if that ever matters; the
        // reader coerces both to [].
        ngKeywords:    input.ngKeywords ?? null,
        genreDeny:     input.genreDeny ?? null,
        timeRangeDeny: input.timeRangeDeny ?? null,
      })
      .returning();
    // Re-resolve with its tvdb join — cheaper than hand-merging.
    const found = await this.findById(inserted.id);
    if (!found) throw new Error(`rule ${inserted.id} vanished after insert`);
    return found;
  }

  async update(id: number, input: z.infer<typeof UpdateRuleSchema>): Promise<Rule | null> {
    // Build a sparse update object — only touch fields the caller supplied.
    const patch: Partial<typeof rules.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.keyword !== undefined) patch.keyword = input.keyword;
    if (input.channels !== undefined) patch.channels = input.channels;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.quality !== undefined) patch.quality = input.quality;
    if (input.skipReruns !== undefined) patch.skipReruns = input.skipReruns;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.tvdb !== undefined) patch.tvdbId = input.tvdb?.id ?? null;
    if (input.ngKeywords !== undefined) patch.ngKeywords = input.ngKeywords;
    if (input.genreDeny !== undefined) patch.genreDeny = input.genreDeny;
    if (input.timeRangeDeny !== undefined) patch.timeRangeDeny = input.timeRangeDeny;

    if (Object.keys(patch).length === 0) {
      // No-op update — just return current state (or null if missing).
      return this.findById(id);
    }

    const updated = await db.update(rules).set(patch).where(eq(rules.id, id)).returning({ id: rules.id });
    if (updated.length === 0) return null;
    return this.findById(id);
  }

  async remove(id: number): Promise<boolean> {
    const deleted = await db.delete(rules).where(eq(rules.id, id)).returning({ id: rules.id });
    return deleted.length > 0;
  }
}

export const ruleService: RuleService = new DrizzleRuleService();
