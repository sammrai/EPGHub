import type { TvdbCastMember, TvdbEntry } from '../schemas/tvdb.ts';
import { TvdbV4HttpClient, type TvdbCharacter } from '../integrations/tvdb/client.ts';
import {
  searchHitToEntry,
  seriesExtendedToEntry,
  movieExtendedToEntry,
  seriesEpisodesLite,
  type SeriesEpisodeLite,
} from '../integrations/tvdb/adapter.ts';

// Absolute URL host for TVDB actor photos. The /series/:id/extended payload
// returns relative paths like `/banners/v4/actor/9150712/photo/abc.jpg`.
const TVDB_ARTWORKS_HOST = 'https://artworks.thetvdb.com';

// Build the absolute URL for a TVDB character image. Empty string when no
// artwork is on file — the UI falls back to a letter avatar in that case.
function absoluteImageUrl(raw: string | undefined): string {
  if (!raw) return '';
  if (/^https?:\/\//.test(raw)) return raw;
  if (raw.startsWith('/')) return `${TVDB_ARTWORKS_HOST}${raw}`;
  return `${TVDB_ARTWORKS_HOST}/${raw}`;
}

// Normalize a TVDB v4 character array → cast rows the UI consumes.
// We only surface "Actor"-typed entries (so director/writer don't show up
// on a 出演者 grid), sort by TVDB's `sort` field, and cap at 12.
export function charactersToCast(raw: TvdbCharacter[] | undefined): TvdbCastMember[] {
  if (!raw || raw.length === 0) return [];
  const actors = raw.filter((c) => !c.peopleType || c.peopleType === 'Actor');
  const sorted = [...actors].sort(
    (a, b) => (a.sort ?? Number.MAX_SAFE_INTEGER) - (b.sort ?? Number.MAX_SAFE_INTEGER),
  );
  return sorted.slice(0, 12).map((c) => ({
    name: c.personName ?? '',
    role: c.name ?? '',
    image: absoluteImageUrl(c.personImgURL ?? c.image),
  }));
}

// Pluggable TVDB provider. Swap the fixture with the real v4 client when
// TVDB_API_KEY is set.
export interface TvdbProvider {
  search(query: string): Promise<TvdbEntry[]>;
  getById(id: number): Promise<TvdbEntry | null>;
  catalog(): Promise<Record<string, TvdbEntry>>;
  /** Episode list (aired order) for a series id, empty for movies. */
  getSeriesEpisodes(id: number): Promise<SeriesEpisodeLite[]>;
  /** Actor cast for a series / movie id. Empty when no data is cached or
   *  the provider can't look it up (fixture mode). */
  getCast(id: number): Promise<TvdbCastMember[]>;
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

  async getCast(): Promise<TvdbCastMember[]> {
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

  async getCast(id: number): Promise<TvdbCastMember[]> {
    // The extended payload already includes `characters` for both series
    // and movies, so we just reuse whichever endpoint resolves. Callers
    // don't necessarily know the kind, so we try series then movie.
    try {
      const ex = await this.client.getSeriesExtended(id);
      return charactersToCast(ex.characters);
    } catch {
      // fall through to movie
    }
    try {
      const ex = await this.client.getMovieExtended(id);
      return charactersToCast(ex.characters);
    } catch {
      return [];
    }
  }
}

// Runtime provider cache. The concrete provider depends on whether a TVDB
// API key is configured (via admin_settings.tvdb.apiKey or, as a bootstrap
// fallback, TVDB_API_KEY env var). Admins rotate the key from the Settings
// page, so the provider is built lazily on first use and rebuilt whenever
// adminSettingsService fires a tvdb.apiKey change event.
let _cached: TvdbProvider | null = null;
let _keyListenerBound = false;

async function build(): Promise<TvdbProvider> {
  // DB key wins over env — adminSettingsService lets operators replace the
  // env-supplied key without redeploying. Empty strings are treated as unset.
  let key: string | null = null;
  try {
    const { getTvdbApiKey } = await import('./adminSettingsService.ts');
    key = await getTvdbApiKey();
  } catch {
    // adminSettingsService unavailable (e.g. pre-DB bootstrap) — env fallback.
  }
  if (!key) {
    const envKey = process.env.TVDB_API_KEY;
    if (envKey && envKey.length > 0 && !envKey.startsWith('your-')) {
      key = envKey;
    }
  }
  if (key) {
    return new TvdbV4Provider(key, process.env.TVDB_API_PIN);
  }
  return new FixtureTvdbProvider();
}

async function getProvider(): Promise<TvdbProvider> {
  if (!_keyListenerBound) {
    _keyListenerBound = true;
    try {
      const { onTvdbApiKeyChange } = await import('./adminSettingsService.ts');
      onTvdbApiKeyChange(() => { _cached = null; });
    } catch {
      // Listener registration best-effort only; getProvider() still works
      // without it (next PATCH simply won't hot-swap until process restart).
    }
  }
  if (!_cached) _cached = await build();
  return _cached;
}

// Public proxy. Each call resolves through getProvider() so the first call
// after a key change picks up the new provider without touching importers.
export const tvdbService: TvdbProvider = {
  async search(query) {
    return (await getProvider()).search(query);
  },
  async getById(id) {
    return (await getProvider()).getById(id);
  },
  async catalog() {
    return (await getProvider()).catalog();
  },
  async getSeriesEpisodes(id) {
    return (await getProvider()).getSeriesEpisodes(id);
  },
  async getCast(id) {
    return (await getProvider()).getCast(id);
  },
};
