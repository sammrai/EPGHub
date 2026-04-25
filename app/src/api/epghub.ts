import type { components } from './epghub.gen';

// Re-export the generated schemas as the UI's API types. These are the
// wire-format shapes. The UI may derive convenience types (e.g. HH:MM
// strings) on top of them.
export type ApiChannel = components['schemas']['Channel'];
export type ApiProgram = components['schemas']['Program'];
export type ApiRule = components['schemas']['Rule'];
export type ApiRecording = components['schemas']['Recording'];
export type ApiCreateRecording = components['schemas']['CreateRecording'];
export type ApiUpdateRecording = components['schemas']['UpdateRecording'];
export type ApiRecordingState = components['schemas']['RecordingState'];
export type ApiRecordingDropSummary = components['schemas']['RecordingDropSummary'];
export type ApiRecordingDropLog = components['schemas']['RecordingDropLog'];
export type ApiTvdbEntry = components['schemas']['TvdbEntry'];
export type ApiTunerState = components['schemas']['TunerState'];
export type ApiTunerAllocation = components['schemas']['TunerAllocation'];
export type ApiTunerSlot = components['schemas']['TunerSlot'];
export type ApiDeviceLiveStatus = components['schemas']['DeviceLiveStatus'];
export type ApiDeviceTunerStatus = components['schemas']['DeviceTunerStatus'];
export type ApiNowRecording = components['schemas']['NowRecording'];
export type ApiSystemStatus = components['schemas']['SystemStatus'];
export type ApiRankingList = components['schemas']['RankingList'];
export type ApiRankingItem = components['schemas']['RankingItem'];
export type ApiRankingGenre = components['schemas']['RankingGenre'];
export type ApiAdminRefreshEpgResult = components['schemas']['AdminRefreshEpgResult'];
export type ApiAdminExpandRulesResult = components['schemas']['AdminExpandRulesResult'];
export type ApiSearchResult = components['schemas']['SearchResult'];
export type ApiChannelSource = components['schemas']['ChannelSource'];
export type ApiChannelSourceKind = components['schemas']['ChannelSourceKind'];
export type ApiCreateChannelSource = components['schemas']['CreateChannelSource'];
export type ApiChannelSourceSyncResult = components['schemas']['ChannelSourceSyncResult'];
export type ApiProbeChannelSourceResult = components['schemas']['ProbeChannelSourceResult'];
export type ApiScannedDevice = components['schemas']['ScannedDevice'];
export type ApiScanResult = components['schemas']['ScanResult'];
export type ApiGpuEncoder = components['schemas']['GpuEncoder'];
export type ApiGpuProbeDetail = components['schemas']['GpuProbeDetail'];
export type ApiGpuProbeResult = components['schemas']['GpuProbeResult'];
export type ApiGpuStatus = components['schemas']['GpuStatus'];
// openapi-typescript turns the zod-openapi `GpuEncoder | null` allOf shape
// into `GpuEncoder & (string | null)` which collapses to string. Hand-roll
// the patch type so `preferred: null` is accepted by the type checker.
export interface ApiGpuSettingsPatch {
  enabled?: boolean;
  preferred?: ApiGpuEncoder | null;
}

export type ApiAdminSettings = components['schemas']['AdminSettings'];
export type ApiAdminSettingsPatch = components['schemas']['AdminSettingsPatch'];
export type ApiRecDefaults = components['schemas']['RecDefaults'];
export type ApiRecEncodePreset = components['schemas']['RecEncodePreset'];
export type ApiPriority = components['schemas']['Priority'];
export type ApiQuality = components['schemas']['Quality'];

// Minimal local shape for the tvdb_entries.episodes jsonb array exposed by
// GET /tvdb/:id/episodes. Kept in sync with server/src/routes/tvdb.ts
// TvdbEpisodeSchema — not yet regenerated into epghub.gen.ts.
export interface ApiTvdbEpisode {
  s: number;
  e: number;
  aired?: string;
  name?: string;
}

export type ApiTvdbCastMember = components['schemas']['TvdbCastMember'];

const BASE = '/api';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
  }
}

export interface ReqOptions {
  signal?: AbortSignal;
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: ReqOptions
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: opts?.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed && 'message' in parsed ? String(parsed.message) : `${method} ${path} → ${res.status}`;
    throw new ApiError(res.status, parsed, msg);
  }
  return parsed as T;
}

export const api = {
  channels: {
    list: (opts?: { source?: string }) => {
      const qs = opts?.source ? `?source=${encodeURIComponent(opts.source)}` : '';
      return req<ApiChannel[]>('GET', `/channels${qs}`);
    },
    patch: (id: string, patch: { enabled?: boolean }) =>
      req<ApiChannel>('PATCH', `/channels/${encodeURIComponent(id)}`, patch),
  },
  schedule: {
    list: (opts?: { date?: string; all?: boolean }) => {
      const qs = new URLSearchParams();
      if (opts?.date) qs.set('date', opts.date);
      if (opts?.all) qs.set('all', '1');
      const q = qs.toString();
      return req<ApiProgram[]>('GET', `/schedule${q ? `?${q}` : ''}`);
    },
  },
  // Unified post-R0 recordings endpoint. One row spans the whole lifecycle:
  // scheduled → recording → encoding → ready (or failed / conflict). See the
  // server route server/src/routes/recordings.ts.
  recordings: {
    list: (opts?: { state?: readonly string[]; signal?: AbortSignal }) => {
      const qs = new URLSearchParams();
      if (opts?.state && opts.state.length > 0) qs.set('state', opts.state.join(','));
      const q = qs.toString();
      return req<ApiRecording[]>('GET', `/recordings${q ? `?${q}` : ''}`, undefined, { signal: opts?.signal });
    },
    get: (id: string) => req<ApiRecording>('GET', `/recordings/${encodeURIComponent(id)}`),
    create: (body: ApiCreateRecording) => req<ApiRecording>('POST', '/recordings', body),
    update: (id: string, patch: ApiUpdateRecording) =>
      req<ApiRecording>('PATCH', `/recordings/${encodeURIComponent(id)}`, patch),
    remove: (id: string) => req<void>('DELETE', `/recordings/${encodeURIComponent(id)}`),
    stop: (id: string) => req<void>('POST', `/recordings/${encodeURIComponent(id)}/stop`),
    drops: (id: string) =>
      req<ApiRecordingDropLog>('GET', `/recordings/${encodeURIComponent(id)}/drops`),
    encode: (id: string) =>
      req<void>('POST', `/recordings/${encodeURIComponent(id)}/encode`),
  },
  rules: {
    list: () => req<ApiRule[]>('GET', '/rules'),
    create: (body: Partial<ApiRule> & { name: string; keyword: string }) =>
      req<ApiRule>('POST', '/rules', body),
    update: (id: number, body: Partial<ApiRule>) => req<ApiRule>('PATCH', `/rules/${id}`, body),
    remove: (id: number) => req<void>('DELETE', `/rules/${id}`),
  },
  tvdb: {
    search: (q: string) => req<ApiTvdbEntry[]>('GET', `/tvdb/search?q=${encodeURIComponent(q)}`),
    getById: (id: number) => req<ApiTvdbEntry>('GET', `/tvdb/${id}`),
    listEpisodes: (tvdbId: number) =>
      req<ApiTvdbEpisode[]>('GET', `/tvdb/${tvdbId}/episodes`),
    getCast: (tvdbId: number) =>
      req<ApiTvdbCastMember[]>('GET', `/tvdb/${tvdbId}/cast`),
  },
  programs: {
    get: (id: string) => req<ApiProgram>('GET', `/programs/${encodeURIComponent(id)}`),
    linkTvdb: (id: string, tvdbId: number) =>
      req<ApiTvdbEntry>('POST', `/programs/${encodeURIComponent(id)}/tvdb`, { tvdbId }),
    unlinkTvdb: (id: string) =>
      req<void>('DELETE', `/programs/${encodeURIComponent(id)}/tvdb`),
    setEpisode: (id: string, season: number | null, episode: number | null) =>
      req<ApiProgram>('PATCH', `/programs/${encodeURIComponent(id)}/tvdb-episode`, { season, episode }),
  },
  tuners: {
    list: () => req<ApiTunerState[]>('GET', '/tuners'),
    allocation: () => req<ApiTunerAllocation>('GET', '/tuners/allocation'),
    live: () => req<ApiDeviceLiveStatus[]>('GET', '/tuners/live'),
    nowRecording: () => req<ApiNowRecording[]>('GET', '/now-recording'),
  },
  system: {
    status: () => req<ApiSystemStatus>('GET', '/system'),
  },
  rankings: {
    list: (genre?: ApiRankingGenre, opts?: ReqOptions) => {
      const qs = genre ? `?genre=${encodeURIComponent(genre)}` : '';
      return req<ApiRankingList>('GET', `/rankings${qs}`, undefined, opts);
    },
  },
  search: {
    query: (q: string, opts?: ReqOptions & { limit?: number }) => {
      const qs = new URLSearchParams({ q });
      if (opts?.limit) qs.set('limit', String(opts.limit));
      return req<ApiSearchResult>('GET', `/search?${qs}`, undefined, opts);
    },
  },
  admin: {
    refreshEpg: () => req<ApiAdminRefreshEpgResult>('POST', '/admin/refresh-epg'),
    expandRules: () => req<ApiAdminExpandRulesResult>('POST', '/admin/expand-rules'),
    channelSources: {
      list: () => req<ApiChannelSource[]>('GET', '/admin/channel-sources'),
      create: (body: ApiCreateChannelSource) =>
        req<ApiChannelSource>('POST', '/admin/channel-sources', body),
      probe: (url: string) =>
        req<ApiProbeChannelSourceResult>('POST', '/admin/channel-sources/probe', { url }),
      scan: () =>
        req<ApiScanResult>('POST', '/admin/channel-sources/scan'),
      sync: (id: number) =>
        req<ApiChannelSourceSyncResult>('POST', `/admin/channel-sources/${id}/sync`),
      remove: (id: number) => req<void>('DELETE', `/admin/channel-sources/${id}`),
    },
    gpu: {
      probe: () => req<ApiGpuProbeResult>('POST', '/admin/gpu/probe'),
      status: () => req<ApiGpuStatus>('GET', '/admin/gpu/status'),
      settings: (patch: ApiGpuSettingsPatch) =>
        req<ApiGpuStatus>('PATCH', '/admin/gpu/settings', patch),
    },
    settings: {
      get: () => req<ApiAdminSettings>('GET', '/admin/settings'),
      patch: (patch: ApiAdminSettingsPatch) =>
        req<ApiAdminSettings>('PATCH', '/admin/settings', patch),
    },
  },
};

// Legacy one-off helper kept for backward compatibility with channelStore.
export async function fetchChannels(): Promise<ApiChannel[]> {
  return api.channels.list();
}
