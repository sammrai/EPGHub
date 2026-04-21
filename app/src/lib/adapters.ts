import type {
  ApiChannel,
  ApiNowRecording,
  ApiProgram,
  ApiRecording,
  ApiRule,
  ApiTunerState,
  ApiTvdbEntry,
} from '../api/epghub';
import type {
  Channel,
  NowRecording,
  Program,
  Recording,
  Rule,
  TvdbEntry,
} from '../data/types';

// ISO times arrive with mixed offsets (Mirakurun serializes UTC as ...Z,
// fixtures write +09:00). Always display in JST — EPG data is JST-anchored
// and mixing zones in the grid has no valid interpretation.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJst(iso: string): Date {
  return new Date(Date.parse(iso) + JST_OFFSET_MS);
}

export function hhmm(iso: string): string {
  const d = toJst(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function jpAirDate(iso: string): string {
  const d = toJst(iso);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getUTCDay()];
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} (${dow}) ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// API Channel already matches UI Channel 1:1.
export const toChannel = (c: ApiChannel): Channel => c;

export const toTvdbEntry = (e: ApiTvdbEntry): TvdbEntry => e;

export function toProgram(
  p: ApiProgram,
  reservedProgramIds: ReadonlySet<string>,
  now: Date
): Program {
  const rec = reservedProgramIds.has(p.id);
  const startMs = Date.parse(p.startAt);
  const endMs = Date.parse(p.endAt);
  const nowMs = now.getTime();
  return {
    id: p.id,
    ch: p.ch,
    start: hhmm(p.startAt),
    end: hhmm(p.endAt),
    startAt: p.startAt,
    endAt: p.endAt,
    title: p.title,
    genre: p.genre,
    ep: p.ep,
    series: p.series,
    tvdb: p.tvdb ?? null,
    rec,
    hd: p.hd,
    desc: p.desc,
    extended: p.extended ?? null,
    video: p.video ?? null,
    tvdbSeason: p.tvdbSeason ?? null,
    tvdbEpisode: p.tvdbEpisode ?? null,
    tvdbEpisodeName: p.tvdbEpisodeName ?? null,
    recording: rec && startMs <= nowMs && endMs > nowMs,
  };
}

export function toRule(r: ApiRule): Rule {
  return {
    id: r.id,
    name: r.name,
    keyword: r.keyword,
    channels: r.channels,
    enabled: r.enabled,
    matches: r.matches,
    nextMatch: r.nextMatch
      ? { ch: r.nextMatch.ch, title: r.nextMatch.title, at: hhmm(r.nextMatch.at) }
      : null,
    priority: r.priority,
    quality: r.quality,
    skipReruns: r.skipReruns,
    kind: r.kind,
    tvdb: r.tvdb,
  };
}

// Wire → domain. Post-R0 a single Recording row spans the whole lifecycle,
// so result fields (filename, size, recordedAt, …) may be null until the
// pipeline has progressed through recording → encoding → ready. Library
// views read only from state='ready' rows where they're populated.
export function toRecording(r: ApiRecording): Recording {
  return {
    id: r.id,
    programId: r.programId,
    ch: r.ch,
    title: r.title,
    startAt: r.startAt,
    endAt: r.endAt,
    priority: r.priority,
    quality: r.quality,
    keepRaw: r.keepRaw,
    marginPre: r.marginPre,
    marginPost: r.marginPost,
    source: r.source,
    state: r.state,
    allocatedTunerIdx: r.allocatedTunerIdx,
    air: r.recordedAt ? jpAirDate(r.recordedAt) : '',
    duration: r.duration ?? 0,
    size: r.size ?? 0,
    filename: r.filename ?? '',
    thumb: r.thumb ?? '',
    thumbGenerated: r.thumbGenerated,
    protected: r.protected,
    new: r.new ?? false,
    tvdbId: r.tvdbId ?? null,
    series: r.series ?? null,
    season: r.season ?? null,
    ep: r.ep ?? null,
    epTitle: r.epTitle ?? null,
    ruleMatched: r.ruleMatched ?? null,
    encodeProgress: r.encodeProgress,
    encodePreset: r.encodePreset ?? null,
    encodeError: r.encodeError ?? null,
    originalStartAt: r.originalStartAt ?? null,
    originalEndAt: r.originalEndAt ?? null,
    extendedBySec: r.extendedBySec,
  };
}

export function toNowRecording(n: ApiNowRecording): NowRecording {
  return {
    id: n.id,
    title: n.title,
    ch: n.ch,
    start: hhmm(n.startAt),
    end: hhmm(n.endAt),
    progress: n.progress,
    series: n.series,
    tvdbId: n.tvdbId,
  };
}

// Post-R0 "upcoming or in-flight" bucket: the recording already has a
// scheduled slot but has not yet been written out as a ready file. Used by
// toProgram() so the Grid/Agenda render the "予約済" / "録画中" badge on the
// corresponding Program cell. `ready` / `failed` rows are excluded because
// they live in the Library/Reserves-done views.
export function reservedProgramIds(recordings: readonly ApiRecording[]): Set<string> {
  return new Set(
    recordings
      .filter(
        (r) =>
          r.state === 'scheduled' ||
          r.state === 'recording' ||
          r.state === 'encoding' ||
          r.state === 'conflict'
      )
      .map((r) => r.programId)
  );
}

export function tunersToUi(list: readonly ApiTunerState[]) {
  const gr = list.find((t) => t.type === 'GR');
  const bs = list.find((t) => t.type === 'BS');
  const cs = list.find((t) => t.type === 'CS');
  return {
    gr: { total: gr?.total ?? 0, inUse: gr?.inUse ?? 0 },
    bs: { total: bs?.total ?? 0, inUse: bs?.inUse ?? 0 },
    cs: { total: cs?.total ?? 0, inUse: cs?.inUse ?? 0 },
  };
}
