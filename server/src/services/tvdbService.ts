import type { TvdbEntry } from '../schemas/tvdb.ts';
import { TvdbV4HttpClient } from '../integrations/tvdb/client.ts';
import {
  searchHitToEntry,
  seriesExtendedToEntry,
  movieExtendedToEntry,
  seriesEpisodesLite,
  type SeriesEpisodeLite,
} from '../integrations/tvdb/adapter.ts';

// Pluggable TVDB provider. Swap the fixture with the real v4 client when
// TVDB_API_KEY is set.
export interface TvdbProvider {
  search(query: string): Promise<TvdbEntry[]>;
  getById(id: number): Promise<TvdbEntry | null>;
  catalog(): Promise<Record<string, TvdbEntry>>;
  /** Episode list (aired order) for a series id, empty for movies. */
  getSeriesEpisodes(id: number): Promise<SeriesEpisodeLite[]>;
}

export class FixtureTvdbProvider implements TvdbProvider {
  async search(query: string): Promise<TvdbEntry[]> {
    const { TVDB_CATALOG } = await import('../../fixtures/tvdb.ts');
    const q = query.trim().toLowerCase();
    if (!q) return Object.values(TVDB_CATALOG);
    return Object.values(TVDB_CATALOG).filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.titleEn.toLowerCase().includes(q) ||
        e.slug.toLowerCase().includes(q)
    );
  }

  async getById(id: number): Promise<TvdbEntry | null> {
    const { TVDB_CATALOG } = await import('../../fixtures/tvdb.ts');
    return Object.values(TVDB_CATALOG).find((e) => e.id === id) ?? null;
  }

  async catalog(): Promise<Record<string, TvdbEntry>> {
    const { TVDB_CATALOG } = await import('../../fixtures/tvdb.ts');
    return TVDB_CATALOG;
  }

  async getSeriesEpisodes(): Promise<SeriesEpisodeLite[]> {
    return [];
  }
}

export class TvdbV4Provider implements TvdbProvider {
  private readonly client: TvdbV4HttpClient;
  // Small in-process cache so the same search doesn't hammer TVDB.
  private readonly searchCache = new Map<string, { at: number; data: TvdbEntry[] }>();
  private readonly detailCache = new Map<number, { at: number; data: TvdbEntry }>();
  private readonly ttlMs = 10 * 60 * 1000;

  constructor(apiKey: string, pin?: string) {
    this.client = new TvdbV4HttpClient(apiKey, pin);
  }

  async search(query: string): Promise<TvdbEntry[]> {
    const q = query.trim();
    if (!q) return [];
    const cached = this.searchCache.get(q);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.data;
    const hits = await this.client.search(q);
    const entries = hits.map(searchHitToEntry).filter((e): e is TvdbEntry => !!e);
    this.searchCache.set(q, { at: Date.now(), data: entries });
    return entries;
  }

  async getById(id: number): Promise<TvdbEntry | null> {
    const cached = this.detailCache.get(id);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.data;
    // Try series then movie. TVDB v4 has separate endpoints and the caller
    // doesn't always know which kind the id belongs to.
    try {
      const ex = await this.client.getSeriesExtended(id);
      const entry = seriesExtendedToEntry(ex);
      this.detailCache.set(id, { at: Date.now(), data: entry });
      return entry;
    } catch {
      // fall through to movie
    }
    try {
      const ex = await this.client.getMovieExtended(id);
      const entry = movieExtendedToEntry(ex);
      this.detailCache.set(id, { at: Date.now(), data: entry });
      return entry;
    } catch {
      return null;
    }
  }

  async catalog(): Promise<Record<string, TvdbEntry>> {
    // Read the local `tvdb_entries` cache (every entry the matcher or a
    // manual link has ever persisted). The Library page needs this to
    // render series/movie cards for any recording whose tvdbId resolves
    // against it — previously returned {} and all TVDB-linked recordings
    // fell through every categorization branch in LibraryPage.
    const { db } = await import('../db/client.ts');
    const { tvdbEntries } = await import('../db/schema.ts');
    const rows = await db.select().from(tvdbEntries);
    const out: Record<string, TvdbEntry> = {};
    for (const row of rows) {
      // rehydrate the TvdbEntry discriminated union from the flat row.
      // Shared fields first; kind-specific fields vary.
      if (row.kind === 'movie') {
        out[String(row.tvdbId)] = {
          type: 'movie',
          id: row.tvdbId,
          slug: row.slug,
          title: row.title,
          titleEn: row.titleEn,
          network: row.network,
          year: row.year,
          poster: row.poster,
          matchedBy: row.matchedBy as TvdbEntry['matchedBy'],
          runtime: row.runtime ?? 0,
          director: row.director ?? '',
          rating: row.rating ?? 0,
        } as TvdbEntry;
      } else {
        out[String(row.tvdbId)] = {
          type: 'series',
          id: row.tvdbId,
          slug: row.slug,
          title: row.title,
          titleEn: row.titleEn,
          network: row.network,
          year: row.year,
          poster: row.poster,
          matchedBy: row.matchedBy as TvdbEntry['matchedBy'],
          totalSeasons: row.totalSeasons ?? 0,
          currentSeason: row.currentSeason ?? 0,
          currentEp: row.currentEp ?? 0,
          totalEps: row.totalEps ?? 0,
          // `status` only exists on the series variant of TvdbEntry; the
          // cast above narrows the union on `type: 'series'`.
          status: ((row.status ?? 'ended') as 'continuing' | 'ended'),
        } as TvdbEntry;
      }
    }
    return out;
  }

  async getSeriesEpisodes(id: number): Promise<SeriesEpisodeLite[]> {
    // `/series/:id/extended?meta=episodes` already includes episodes; reuse
    // that response so we don't make an extra roundtrip.
    try {
      const ex = await this.client.getSeriesExtended(id);
      return seriesEpisodesLite(ex);
    } catch {
      return [];
    }
  }
}

function build(): TvdbProvider {
  const key = process.env.TVDB_API_KEY;
  if (key && key.length > 0 && !key.startsWith('your-')) {
    return new TvdbV4Provider(key, process.env.TVDB_API_PIN);
  }
  return new FixtureTvdbProvider();
}

export const tvdbService: TvdbProvider = build();
