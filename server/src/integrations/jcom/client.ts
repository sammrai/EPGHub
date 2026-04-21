import { z } from 'zod';

// -----------------------------------------------------------------
// JCOM ranking API client
// -----------------------------------------------------------------
// JCOM's public TV guide exposes `予約ランキング` at
//   https://tvguide.myjcom.jp/api/getRankingInfo/
//
// There is no public documentation; the shape below is derived from a live
// response captured at 2026-04-19 (see server/fixtures/jcom-ranking-sample.json).
//
// Notable bits:
//   - RankingList is already sorted; position 0 is rank 1.
//   - `prevRank` is a string ('' for new entries). Delta = prevRank − rank
//     (positive means moved up, zero means unchanged, null for new).
//   - `nextBroadcast` is an array; if empty the program has no upcoming
//     broadcast (rare but we must tolerate it).
//   - `genreIds` under nextBroadcast use ARIB hex-pair codes. We don't try
//     to re-normalize them because the caller already filters by genre via
//     the URL `genreId` parameter.
//
// The endpoint does not set CORS headers for browser clients but responds
// fine to server-to-server fetches. If it ever returns HTML (maintenance
// page) the zod parse fails and we fall back to an empty list rather than
// crashing the sync loop.

// ARIB hex ids accepted by the `genreId` query parameter.
// Keep both the JCOM-literal id (hex char) and the existing ARIB genre key
// used elsewhere in epghub (see integrations/mirakurun/adapter.ts).
export const JCOM_GENRES = [
  { id: '6', key: 'movie',  label: '映画' },
  { id: '3', key: 'drama',  label: 'ドラマ' },
  { id: '1', key: 'sport',  label: 'スポーツ' },
  { id: '7', key: 'anime',  label: 'アニメ' },
  { id: '4', key: 'music',  label: '音楽' },
  { id: '5', key: 'var',    label: 'バラエティ' },
  { id: '8', key: 'doc',    label: 'ドキュメンタリー' },
  { id: 'A', key: 'edu',    label: '教育' },
  { id: '9', key: 'doc',    label: '劇場' },
] as const;

export type JcomGenreId = (typeof JCOM_GENRES)[number]['id'];

const NextBroadcastSchema = z.object({
  eid:             z.string().optional(),
  nextTitle:       z.string().optional(),
  startDateTime:   z.string().optional(),  // YYYYMMDDHHMMSS (JST)
  endDateTime:     z.string().optional(),
  airTime:         z.string().optional(),
  genreIds:        z.array(z.string()).optional(),
  serviceCode:     z.string().optional(),
  channelType:     z.string().optional(),
  channelNo:       z.string().optional(),
  channelName:     z.string().optional(),
  channelLogoUrl:  z.string().optional(),
});

const PhotoSchema = z.object({
  photo:      z.string().optional(),
  copyright:  z.string().optional(),
});

const RankingRowSchema = z.object({
  score:          z.string().optional(),
  prevRank:       z.string().optional(),      // '' when new entry
  programId:      z.string().optional(),
  title:          z.string(),
  url:            z.string().optional(),
  photos:         z.array(PhotoSchema).optional(),
  nextBroadcast:  z.array(NextBroadcastSchema).optional(),
});

export type JcomRankingRow = z.infer<typeof RankingRowSchema>;

const RankingResponseSchema = z.object({
  status:       z.string().optional(),
  summaryFrom:  z.string().optional(),
  summaryTo:    z.string().optional(),
  count:        z.number().optional(),
  RankingList:  z.array(RankingRowSchema).default([]),
});

export type JcomRankingResponse = z.infer<typeof RankingResponseSchema>;

const DEFAULT_TIMEOUT_MS = 10_000;
const BASE_URL = 'https://tvguide.myjcom.jp/api/getRankingInfo/';
const AREA_ID = '108';  // Tokyo area. Not user-configurable yet.

export interface JcomFetchOpts {
  /** JCOM ARIB hex genre id, or null for the global (all-genre) board. */
  genreId: JcomGenreId | null;
  /** Max rows to request. JCOM caps around 20. */
  limit?: number;
}

/**
 * Fetch a single ranking board from JCOM. Returns [] on any failure
 * (timeout, non-2xx, HTML maintenance response, unexpected schema) so the
 * caller — the periodic sync worker — can keep going and retry later.
 */
export async function fetchJcomRanking(opts: JcomFetchOpts): Promise<JcomRankingRow[]> {
  const qs = new URLSearchParams({
    rankingType: '1',
    channelType: '2',
    genreId: opts.genreId ?? '',
    areaId: AREA_ID,
    limit: String(opts.limit ?? 20),
  });
  const url = `${BASE_URL}?${qs.toString()}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        // JCOM returns HTML for some user-agents; a normal browser UA is
        // accepted. Keep this opaque — there is no auth.
        'user-agent': 'Mozilla/5.0 (epghub ranking sync)',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[jcom] ${url} → HTTP ${res.status}`);
      return [];
    }
    const contentType = res.headers.get('content-type') ?? '';
    // Maintenance pages come back as text/html. Treat as empty rather than
    // parsing garbage.
    if (!contentType.includes('json')) {
      console.warn(`[jcom] ${url} unexpected content-type ${contentType}`);
      return [];
    }
    const raw = (await res.json()) as unknown;
    const parsed = RankingResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[jcom] response schema mismatch', parsed.error.issues.slice(0, 3));
      return [];
    }
    return parsed.data.RankingList;
  } catch (err) {
    console.warn('[jcom] fetch failed', (err as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
