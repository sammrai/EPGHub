import type { Channel, Program, Recording, TvdbSeries } from '../data/types';

export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const fromMin = (mins: number): string => {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// Broadcast-day math. JST broadcast day starts at 05:00, so a scroll offset
// of 0–23:59 hours past `baseDate` 05:00 belongs to `baseDate`, and 24h+
// wraps to the next day. Used by Grid / Timeline to answer "what broadcast
// day is the user currently looking at?" so the Subheader can display a
// live "表示中: MM/DD" chip as they scroll (課題#13).
export const broadcastDayAt = (baseDate: string, minutesFromBase: number): string => {
  const dayOffset = Math.floor(minutesFromBase / (24 * 60));
  const [y, m, d] = baseDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dayOffset);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

export const durMin = (p: Program): number => {
  // Prefer ISO timestamps when both are present — they handle day wraps and
  // DST/timezone edge cases correctly for multi-day schedules.
  if (p.startAt && p.endAt) {
    const start = Date.parse(p.startAt);
    const end = Date.parse(p.endAt);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const diff = Math.round((end - start) / 60000);
      if (diff >= 0) return diff;
    }
  }
  // Fallback: HH:MM arithmetic. If end < start, the program crosses midnight
  // so add 24h. Never return negative.
  const startM = toMin(p.start);
  const endM = toMin(p.end);
  const diff = endM - startM;
  if (diff < 0) return diff + 24 * 60;
  return diff;
};

export const durLabel = (p: Program): string => {
  const d = durMin(p);
  if (d >= 60) {
    const h = Math.floor(d / 60);
    const m = d % 60;
    return m === 0 ? `${h}時間` : `${h}時間${m}分`;
  }
  return `${d}分`;
};

// "Now" in minutes-from-midnight for whatever day the UI is viewing. Using
// JST consistently because the EPG data is all JST. Overridable via the
// VITE_MOCK_NOW env (format HH:MM) so we can replay the prototype's demo
// layout that was anchored at 20:12.
const mockOverride = (import.meta.env?.VITE_MOCK_NOW as string | undefined)?.match(/^(\d{1,2}):(\d{2})$/);

function jstNowMinutes(): number {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export const MOCK_NOW_MIN: number = mockOverride
  ? Number(mockOverride[1]) * 60 + Number(mockOverride[2])
  : jstNowMinutes();

export const getChannel = (
  channels: Channel[],
  id: string
): Channel | undefined => channels.find((c) => c.id === id);

export const findSeries = (programs: Program[], seriesKey: string | null): Program[] => {
  if (!seriesKey) return [];
  return programs.filter((p) => p.series === seriesKey);
};

export const progId = (p: Program): string => {
  // Prefer the adapter-provided unique id — it already disambiguates cross-day
  // programs because it derives from the API's unique program identifier.
  if (p.id) return p.id;
  // Next-best: include the ISO start so daily reruns on different days don't
  // collide (e.g. 01:00 on D and D+1).
  if (p.startAt) return `${p.ch}-${p.startAt}-${p.title.slice(0, 8)}`;
  // Legacy fallback for fixtures / Modal-synthesized programs without ISO.
  return `${p.ch}-${p.start}-${p.title.slice(0, 8)}`;
};

// TVDB /search hits return 0 for episode/season counts because the search
// payload lacks that detail — extended fetch fills it in later. Until then,
// fall back to what we can compute from local recordings so the UI shows a
// real number instead of a fake "0話" or "0/0 シーズン".
export interface SeriesCounts {
  totalEps: number;
  currentEp: number;
  totalSeasons: number;
  currentSeason: number;
  /** True when the number is a local-fallback (not authoritative from TVDB). */
  partial: boolean;
}

export const seriesCounts = (
  tvdb: TvdbSeries,
  recorded: Recording[]
): SeriesCounts => {
  const seasons = new Set<number>();
  let maxSeason = 0;
  let maxEpInMax = 0;
  for (const r of recorded) {
    if (r.tvdbId !== tvdb.id) continue;
    if (r.season != null) {
      seasons.add(r.season);
      if (r.season > maxSeason) {
        maxSeason = r.season;
        maxEpInMax = r.ep ?? 0;
      } else if (r.season === maxSeason) {
        maxEpInMax = Math.max(maxEpInMax, r.ep ?? 0);
      }
    }
  }
  const recCount = recorded.filter((r) => r.tvdbId === tvdb.id).length;
  const partial =
    tvdb.totalEps === 0 ||
    tvdb.totalSeasons === 0 ||
    tvdb.currentEp === 0 ||
    tvdb.currentSeason === 0;
  return {
    totalEps: tvdb.totalEps || recCount,
    currentEp: tvdb.currentEp || maxEpInMax || recCount,
    totalSeasons: tvdb.totalSeasons || seasons.size || (maxSeason > 0 ? 1 : 0),
    currentSeason: tvdb.currentSeason || maxSeason || 0,
    partial,
  };
};
