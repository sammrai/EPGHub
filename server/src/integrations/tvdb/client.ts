// Minimal client for the TVDB v4 REST API (https://thetvdb.github.io/v4-api/).
// We only hit /v4/login, /v4/search, /v4/series/:id/extended and
// /v4/movies/:id/extended. Anything beyond that is callers' problem.

interface SearchResult {
  tvdb_id: string;
  objectID: string;
  type: 'series' | 'movie' | 'person' | 'company' | 'episode';
  name: string;
  translations?: Record<string, string>;
  overviews?: Record<string, string>;
  image_url?: string;
  network?: string;
  year?: string;
  slug?: string;
  country?: string;
}

interface SeriesExtended {
  id: number;
  name: string;
  slug?: string;
  image?: string;
  firstAired?: string;
  year?: string;
  status?: { name?: string };
  originalNetwork?: { name?: string };
  originalCountry?: string;
  seasons?: Array<{
    id: number;
    seriesId: number;
    type: { type: string; name: string };
    number: number;
  }>;
  episodes?: Array<{
    id: number;
    seasonNumber?: number;
    number?: number;
    aired?: string;       // ISO date "YYYY-MM-DD"
    name?: string;
    overview?: string;
    runtime?: number;
  }>;
  translations?: {
    nameTranslations?: Array<{ language: string; name: string }>;
    overviewTranslations?: Array<{ language: string; overview: string }>;
  };
}

interface MovieExtended {
  id: number;
  name: string;
  slug?: string;
  image?: string;
  runtime?: number;
  year?: string;
  score?: number;
  originalCountry?: string;
  companies?: { network?: Array<{ name: string }> };
  translations?: {
    nameTranslations?: Array<{ language: string; name: string }>;
  };
  crew?: Array<{ name: string; peopleType: string }>;
}

export interface TvdbLoginResponse {
  status: string;
  data: { token: string };
}
export interface TvdbEnvelope<T> { status: string; data: T }

const V4_BASE = 'https://api4.thetvdb.com/v4';
const TOKEN_TTL_MS = 25 * 24 * 60 * 60 * 1000; // refresh before 30-day expiry
const SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 1 week — titles rarely change
const DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 1 week — series/movie detail is stable

import { FileCache } from '../../lib/fileCache.ts';
import { resolve } from 'node:path';

const CACHE_BASE = process.env.TVDB_CACHE_DIR ?? resolve('/tmp/epghub/tvdb');

export class TvdbV4HttpClient {
  private token: string | null = null;
  private tokenAt = 0;

  // Three separate caches so TTLs can differ: login tokens live for ~25d,
  // search results for a day, detail payloads for a week. All backed by
  // /tmp/epghub/tvdb (override with TVDB_CACHE_DIR).
  private readonly tokenCache = new FileCache(CACHE_BASE, TOKEN_TTL_MS);
  private readonly searchCache = new FileCache(`${CACHE_BASE}/search`, SEARCH_TTL_MS);
  private readonly detailCache = new FileCache(`${CACHE_BASE}/detail`, DETAIL_TTL_MS);

  constructor(private readonly apiKey: string, private readonly pin?: string) {}

  private async login(): Promise<string> {
    if (this.token && Date.now() - this.tokenAt < TOKEN_TTL_MS) return this.token;
    // Reuse a valid token from a previous process if it's still in the cache.
    const cached = await this.tokenCache.get<{ token: string }>(`token:${this.apiKey}`);
    if (cached?.token) {
      this.token = cached.token;
      this.tokenAt = Date.now();
      return this.token;
    }
    const body: Record<string, string> = { apikey: this.apiKey };
    if (this.pin) body.pin = this.pin;
    const res = await fetch(`${V4_BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`TVDB login ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as TvdbLoginResponse;
    this.token = json.data.token;
    this.tokenAt = Date.now();
    await this.tokenCache.set(`token:${this.apiKey}`, { token: this.token });
    return this.token;
  }

  private async authedGet<T>(path: string): Promise<T> {
    const token = await this.login();
    const res = await fetch(`${V4_BASE}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`TVDB ${path} ${res.status}: ${await res.text().catch(() => '')}`);
    const env = (await res.json()) as TvdbEnvelope<T>;
    return env.data;
  }

  async search(query: string, type?: 'series' | 'movie'): Promise<SearchResult[]> {
    const cacheKey = `search:${type ?? 'any'}:jpn:${query}`;
    const hit = await this.searchCache.get<SearchResult[]>(cacheKey);
    if (hit) return hit;
    const qs = new URLSearchParams({ query });
    if (type) qs.set('type', type);
    qs.set('language', 'jpn');
    const data = await this.authedGet<SearchResult[]>(`/search?${qs.toString()}`);
    await this.searchCache.set(cacheKey, data);
    return data;
  }

  async getSeriesExtended(id: number): Promise<SeriesExtended> {
    const cacheKey = `series:${id}`;
    const hit = await this.detailCache.get<SeriesExtended>(cacheKey);
    if (hit) return hit;
    // `meta=episodes` asks TVDB to inline the full episode list into the
    // extended payload so we can compute totalSeasons / currentSeason /
    // currentEp without an extra roundtrip.
    const data = await this.authedGet<SeriesExtended>(`/series/${id}/extended?meta=episodes&short=false`);
    await this.detailCache.set(cacheKey, data);
    return data;
  }

  /**
   * Episode list for a series in a given season-type + language. TVDB v4
   * exposes this under /series/{id}/episodes/{season-type}/{lang}. Season
   * types we care about: "default" (production/aired order), "absolute",
   * "dvd". We ask for the default order so the episode numbering matches
   * what broadcasters air.
   */
  async getSeriesEpisodes(
    id: number,
    seasonType: 'default' | 'absolute' | 'dvd' = 'default',
  ): Promise<NonNullable<SeriesExtended['episodes']>> {
    const cacheKey = `series-eps:${id}:${seasonType}`;
    const hit = await this.detailCache.get<NonNullable<SeriesExtended['episodes']>>(cacheKey);
    if (hit) return hit;
    const data = await this.authedGet<{ episodes: NonNullable<SeriesExtended['episodes']> }>(
      `/series/${id}/episodes/${seasonType}/jpn`,
    );
    const list = data?.episodes ?? [];
    await this.detailCache.set(cacheKey, list);
    return list;
  }

  async getMovieExtended(id: number): Promise<MovieExtended> {
    const cacheKey = `movie:${id}`;
    const hit = await this.detailCache.get<MovieExtended>(cacheKey);
    if (hit) return hit;
    const data = await this.authedGet<MovieExtended>(`/movies/${id}/extended`);
    await this.detailCache.set(cacheKey, data);
    return data;
  }
}

export type { SearchResult, SeriesExtended, MovieExtended };
