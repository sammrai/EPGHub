// ChannelProvider 抽象 — kind 分岐をここに閉じ込めるための型。
//
// 設計思想 (CLAUDE.md の "Channel source protocol" 参照):
//   IPTV (HDHomeRun discover.json + m3u + XMLTV) が基本プロトコル。
//   Mirakurun はそれに加えて JSON ベースの高機能 API (/api/services,
//   /api/programs, /api/tuners, /api/events/stream) を持つ拡張版。
//
//   したがって IptvProvider が基底クラスで、MirakurunProvider はそれを
//   継承し、より高品質なデータが取れる method を override する。

import type { MrEvent, MrEventStream } from '../integrations/mirakurun/client.ts';

export interface ProviderRow {
  id: number;
  name: string;
  kind: string;
  url: string;
  xmltvUrl: string | null;
  friendlyName: string | null;
  model: string | null;
  deviceId: string | null;
  tunerCount: number | null;
}

export interface DiscoverInfo {
  friendlyName: string | null;
  model: string | null;
  deviceId: string | null;
  tunerCount: number | null;
}

export interface TunerStatus {
  tunerIdx: number;
  vctName: string | null;
  vctNumber: string | null;
  targetIp: string | null;
  inUse: boolean;
}

export interface SyncResult {
  channelCount: number;
  /** Non-fatal warning surfaced to admin UI (e.g. xmltv parse failure). */
  warning?: string;
}

export interface LiveEventHandlers {
  onEvent: (ev: MrEvent) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
}

// All providers expose this surface. Method bodies live in the concrete
// subclasses; the registry returns the right one for a given row.
export interface ChannelProvider {
  readonly kind: string;
  readonly row: ProviderRow;
  syncChannelsAndProgrammes(): Promise<SyncResult>;
  fetchDiscover(): Promise<DiscoverInfo | null>;
  fetchTunerStatuses(): Promise<TunerStatus[]>;
  /** Cheap reachability probe used when no per-tuner status is available. */
  probeReachable(): Promise<boolean>;
  /**
   * SSE / event stream support. Default = unsupported (null). Mirakurun
   * overrides this to start a live EIT[p/f] stream.
   */
  subscribeLiveEvents(handlers: LiveEventHandlers): MrEventStream | null;
}
