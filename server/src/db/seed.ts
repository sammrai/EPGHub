import { db } from './client.ts';
import { rules, tvdbEntries } from './schema.ts';
import { sql } from 'drizzle-orm';

// Seed DB tables from fixtures on first boot only (when the table is empty).
// This keeps dev UX nice (non-empty UI state on a fresh Postgres) without
// clobbering real data once the user starts editing via the API.
//
// Gated on MIRAKURUN_URL being unset: when a real tuner is wired up we
// don't want fictional rule rows polluting the Rules tab. The TVDB
// catalog seed is skipped too — the matcher populates tvdb_entries from
// live searches instead.
//
// After the R0 unification we no longer seed fake recorded/recording rows.
// The dev-side seedDev() in app.ts creates scheduled recordings from
// fixture programs when needed; that's enough to light up the UI.
export async function seedDbIfEmpty(): Promise<void> {
  if (process.env.MIRAKURUN_URL) return;
  await seedTvdbEntriesIfEmpty();
  await seedRulesIfEmpty();
}

async function seedTvdbEntriesIfEmpty(): Promise<void> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(tvdbEntries);
  if ((row?.c ?? 0) > 0) return;
  const { TVDB_CATALOG } = await import('../../fixtures/tvdb.ts');
  const values = Object.values(TVDB_CATALOG).map((e) => ({
    tvdbId: e.id,
    slug: e.slug,
    kind: e.type,
    title: e.title,
    titleEn: e.titleEn,
    network: e.network,
    year: e.year,
    poster: e.poster,
    matchedBy: e.matchedBy,
    totalSeasons: e.type === 'series' ? e.totalSeasons : null,
    currentSeason: e.type === 'series' ? e.currentSeason : null,
    currentEp: e.type === 'series' ? e.currentEp : null,
    totalEps: e.type === 'series' ? e.totalEps : null,
    status: e.type === 'series' ? e.status : null,
    runtime: e.type === 'movie' ? e.runtime : null,
    director: e.type === 'movie' ? e.director : null,
    rating: e.type === 'movie' ? e.rating : null,
  }));
  if (values.length) await db.insert(tvdbEntries).values(values);
}

async function seedRulesIfEmpty(): Promise<void> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(rules);
  if ((row?.c ?? 0) > 0) return;
  const { RULES } = await import('../../fixtures/rules.ts');
  if (!RULES.length) return;

  const values = RULES.map((r) => ({
    id: r.id,
    name: r.name,
    keyword: r.keyword,
    channels: r.channels,
    enabled: r.enabled,
    matches: r.matches,
    nextMatchCh: r.nextMatch?.ch ?? null,
    nextMatchTitle: r.nextMatch?.title ?? null,
    nextMatchAt: r.nextMatch ? new Date(r.nextMatch.at) : null,
    priority: r.priority,
    quality: r.quality,
    skipReruns: r.skipReruns,
    kind: r.kind,
    tvdbId: r.tvdb?.id ?? null,
  }));
  await db.insert(rules).values(values);
  const maxId = Math.max(...RULES.map((r) => r.id), 0);
  if (maxId > 0) {
    await db.execute(sql`SELECT setval(pg_get_serial_sequence('rules', 'id'), ${maxId})`);
  }
}
