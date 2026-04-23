export type BcType = 'GR' | 'BS' | 'CS';

export interface Channel {
  id: string;
  name: string;
  short: string;
  number: string;
  type: BcType;
  color: string;
  enabled: boolean;
}

export interface Genre {
  key: string;
  label: string;
  dot: string;
}

export interface Program {
  id?: string;
  ch: string;
  start: string;
  end: string;
  /** ISO-8601 start/end timestamps. Preserved from the API so the grid
   *  can position programs across day boundaries (48h continuous scroll)
   *  without losing the calendar day that `start`/`end` drop. */
  startAt?: string;
  endAt?: string;
  title: string;
  genre: Genre;
  ep: string | null;
  series: string | null;
  tvdb?: TvdbEntry | null;
  rec?: boolean;
  hd?: boolean;
  selected?: boolean;
  desc?: string;
  sizeRaw?: number;
  priority?: 'high' | 'medium' | 'low';
  ruleMatched?: string;
  recording?: boolean;
  /** ARIB extended descriptor key/value pairs from the broadcaster
   *  (cast, staff, music, subtitle, …). Optional — older EPG feeds omit it. */
  extended?: Record<string, string> | null;
  /** Broadcaster-reported video format (`1080i`, `720p`, …). */
  video?: string | null;
  /** TVDB season / episode / episode name for this specific airing. */
  tvdbSeason?: number | null;
  tvdbEpisode?: number | null;
  tvdbEpisodeName?: string | null;
}

export interface TvdbBase {
  id: number;
  slug: string;
  title: string;
  titleEn: string;
  network: string;
  year: number;
  poster: string;
  matchedBy: string;
}

export interface TvdbSeries extends TvdbBase {
  type: 'series';
  totalSeasons: number;
  currentSeason: number;
  currentEp: number;
  totalEps: number;
  status: 'continuing' | 'ended';
}

export interface TvdbMovie extends TvdbBase {
  type: 'movie';
  runtime: number;
  director: string;
  rating: number;
}

export type TvdbEntry = TvdbSeries | TvdbMovie;

export interface RuleNextMatch {
  ch: string;
  title: string;
  at: string;
}

export interface Rule {
  id: number;
  name: string;
  keyword: string;
  channels: string[];
  enabled: boolean;
  matches: number;
  nextMatch: RuleNextMatch | null;
  priority: 'high' | 'medium' | 'low';
  quality: string;
  skipReruns: boolean;
  kind?: 'keyword' | 'series';
  tvdb?: TvdbEntry;
}

export type RecordingState =
  | 'scheduled'
  | 'recording'
  | 'encoding'
  | 'ready'
  | 'failed'
  | 'conflict';

// Unified post-R0 Recording row. One row spans the full lifecycle from
// "scheduled" (予約) through "recording" / "encoding" to "ready" (録画済).
// Plan fields are always set; result fields are only populated once the
// pipeline has progressed that far.
export interface Recording {
  // --- plan fields (always present) ---
  id: string;
  programId: string;
  ch: string;
  title: string;
  /** ISO-8601 start. Needed by the Reserves page for edit/display. */
  startAt: string;
  /** ISO-8601 end. */
  endAt: string;
  priority: 'high' | 'medium' | 'low';
  quality: string;
  keepRaw: boolean;
  marginPre: number;
  marginPost: number;
  source: { kind: 'once' } | { kind: 'rule'; ruleId: number } | { kind: 'series'; tvdbId: number };
  state: RecordingState;
  allocatedTunerIdx?: number;

  // --- result fields (null/undefined until state progresses) ---
  /** JST air-date display string, derived from recordedAt for library UI. */
  air: string;
  /** Minutes of actual recorded content (mirror of API duration). */
  duration: number;
  /** Size in GB (mirror of API size). */
  size: number;
  filename: string;
  thumb: string;
  thumbGenerated?: boolean;
  protected?: boolean;
  new?: boolean;
  tvdbId: number | null;
  series: string | null;
  season: number | null;
  ep: number | null;
  epTitle: string | null;
  ruleMatched?: string | null;
  encodeProgress?: number;
  encodePreset?: string | null;
  encodeError?: string | null;
  originalStartAt?: string | null;
  originalEndAt?: string | null;
  extendedBySec?: number;
}

export interface NowRecording {
  id: string;
  title: string;
  ch: string;
  start: string;
  end: string;
  progress: number;
  series: string | null;
  tvdbId: number | null;
}

export interface SystemInfo {
  storage: { total: number; used: number; unit: string };
  tuners: {
    gr: { total: number; inUse: number };
    bs: { total: number; inUse: number };
    cs: { total: number; inUse: number };
  };
  upcoming: number;
  today: string;
}
