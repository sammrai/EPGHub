import type { TvdbEntry, TvdbMovie, TvdbSeries } from '../../schemas/tvdb.ts';
import type { SearchResult, SeriesExtended, MovieExtended } from './client.ts';

export interface SeriesEpisodeLite {
  s: number;
  e: number;
  aired?: string;
  name?: string;
}

export function seriesEpisodesLite(ex: SeriesExtended): SeriesEpisodeLite[] {
  return (ex.episodes ?? [])
    .filter((ep) => typeof ep.seasonNumber === 'number' && typeof ep.number === 'number')
    .map((ep) => ({
      s: ep.seasonNumber!,
      e: ep.number!,
      aired: ep.aired,
      name: ep.name,
    }));
}

const jpFirst = (map?: Record<string, string>): string | undefined =>
  map ? map['jpn'] ?? map['ja'] ?? undefined : undefined;

const jpName = (t?: SeriesExtended['translations']): string | undefined => {
  const n = t?.nameTranslations?.find((e) => e.language === 'jpn' || e.language === 'ja');
  return n?.name;
};

// Normalize a /search result into our TvdbEntry shape. The /search payload
// doesn't include all fields we want (runtime, director, season counts) — we
// populate what we can and the caller can upgrade via /series|/movies /:id.
export function searchHitToEntry(hit: SearchResult): TvdbEntry | null {
  const tvdbId = Number(hit.tvdb_id);
  if (!Number.isFinite(tvdbId)) return null;
  const titleJa = jpFirst(hit.translations) ?? hit.name;
  const base = {
    id: tvdbId,
    slug: hit.slug ?? String(tvdbId),
    title: titleJa,
    titleEn: hit.name,
    network: hit.network ?? '',
    year: Number(hit.year) || 0,
    poster: hit.image_url ?? '',
    matchedBy: 'TVDB v4 検索',
  } as const;
  if (hit.type === 'series') {
    const entry: TvdbSeries = {
      type: 'series',
      ...base,
      totalSeasons: 0,
      currentSeason: 0,
      currentEp: 0,
      totalEps: 0,
      status: 'continuing',
    };
    return entry;
  }
  if (hit.type === 'movie') {
    const entry: TvdbMovie = {
      type: 'movie',
      ...base,
      runtime: 0,
      director: '',
      rating: 0,
    };
    return entry;
  }
  return null;
}

export function seriesExtendedToEntry(ex: SeriesExtended): TvdbSeries {
  const titleJa = jpName(ex.translations) ?? ex.name;
  // Count only "Aired Order" / official seasons for the season totals. TVDB
  // also exposes alt orderings (DVD, absolute, …) which would double-count.
  const regularSeasons = (ex.seasons ?? []).filter(
    (s) => s.type?.type === 'official' || s.type?.name === 'Aired Order'
  );
  // Episodes come inline when the client fetched with `meta=episodes`. We
  // need the aired-order episodes only — some shows tag specials as season 0.
  const epsPerSeason = new Map<number, number>();
  for (const ep of ex.episodes ?? []) {
    if (typeof ep.seasonNumber !== 'number') continue;
    epsPerSeason.set(ep.seasonNumber, (epsPerSeason.get(ep.seasonNumber) ?? 0) + 1);
  }
  const totalEps = Array.from(epsPerSeason.values()).reduce((s, n) => s + n, 0);
  // currentSeason: highest season number that has at least one aired episode.
  // Use the episode data when available, fall back to the seasons array.
  const episodeSeasons = Array.from(epsPerSeason.keys()).filter((s) => s > 0);
  const currentSeason = episodeSeasons.length > 0
    ? Math.max(...episodeSeasons)
    : regularSeasons.reduce((m, s) => (s.number > m ? s.number : m), 0);
  // For long-running shows structured by year (e.g. イッテQ), totalSeasons
  // from the seasons list is the authoritative "number of distinct seasons".
  // Fall back to the count of seasons we saw episodes in.
  const totalSeasons = regularSeasons.length || episodeSeasons.length || (ex.seasons?.length ?? 0);
  const currentEp = epsPerSeason.get(currentSeason) ?? 0;
  const status =
    (ex.status?.name ?? '').toLowerCase().includes('end') ? 'ended' : 'continuing';
  return {
    type: 'series',
    id: ex.id,
    slug: ex.slug ?? String(ex.id),
    title: titleJa,
    titleEn: ex.name,
    network: ex.originalNetwork?.name ?? '',
    year: Number(ex.year ?? ex.firstAired?.slice(0, 4) ?? 0) || 0,
    poster: ex.image ?? '',
    matchedBy: 'TVDB v4 series/extended',
    totalSeasons,
    currentSeason,
    currentEp,
    totalEps,
    status,
  };
}

export function movieExtendedToEntry(ex: MovieExtended): TvdbMovie {
  const titleJa = jpName(ex.translations as SeriesExtended['translations']) ?? ex.name;
  const director = (ex.crew ?? []).find((c) => c.peopleType === 'Director')?.name ?? '';
  return {
    type: 'movie',
    id: ex.id,
    slug: ex.slug ?? String(ex.id),
    title: titleJa,
    titleEn: ex.name,
    network: ex.companies?.network?.[0]?.name ?? '',
    year: Number(ex.year ?? 0) || 0,
    poster: ex.image ?? '',
    matchedBy: 'TVDB v4 movies/extended',
    runtime: ex.runtime ?? 0,
    director,
    rating: ex.score ?? 0,
  };
}
