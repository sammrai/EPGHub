// IptvProvider — baseline (HDHomeRun discover.json + m3u + XMLTV).
//
// Covers any device that speaks the HDHomeRun-style IPTV protocol:
//   * GET <url>                              → #EXTM3U playlist
//   * GET <xmltvUrl>     (optional)          → XMLTV programmes
//   * GET <derive(url)>/discover.json        → device metadata
//   * GET <derive(url)>/tuner{N}/status      → per-tuner status (when tunerCount > 0)
//
// MirakurunProvider extends this and overrides the channel/programme/
// tuner-status methods with the richer Mirakurun-native endpoints, but
// keeps fetchDiscover() as-is — Mirakurun implements HDHomeRun discover
// at /api/iptv/discover.json identically.

import { createHash } from 'node:crypto';
import { db } from '../db/client.ts';
import { channels } from '../db/schema.ts';
import { parseM3u, type M3uEntry } from '../integrations/m3u/parser.ts';
import { parseXmltv } from '../integrations/xmltv/parser.ts';
import { fetchHdhomerunDiscover } from '../integrations/hdhomerun/discover.ts';
import { fetchAllTunerStatuses } from '../integrations/hdhomerun/tunerStatus.ts';
import { programService } from '../services/programService.ts';
import { genreFromKey } from '../lib/genreRegistry.ts';
import type { Program } from '../schemas/program.ts';
import type {
  ChannelProvider,
  DiscoverInfo,
  LiveEventHandlers,
  ProviderRow,
  SyncResult,
  TunerStatus,
} from './types.ts';
import type { MrEventStream } from '../integrations/mirakurun/client.ts';

const FETCH_TIMEOUT_MS = 30_000;
const REACHABILITY_TIMEOUT_MS = 3_000;

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function m3uChannelId(entry: M3uEntry): string {
  const seed = entry.tvgId && entry.tvgId.trim().length > 0
    ? entry.tvgId.trim()
    : createHash('sha1').update(entry.streamUrl).digest('hex').slice(0, 12);
  return `m3u-${seed}`;
}

function inferType(group?: string): 'GR' | 'BS' | 'CS' {
  if (!group) return 'GR';
  const g = group.toUpperCase();
  if (g.includes('BS')) return 'BS';
  if (g.includes('CS')) return 'CS';
  return 'GR';
}

const HUE_PALETTE = [28, 140, 30, 250, 260, 150, 280, 200, 220, 300, 0, 340];

function m3uToChannelValues(entry: M3uEntry, sourceId: number) {
  const id = m3uChannelId(entry);
  const name = entry.tvgName && entry.tvgName.length > 0 ? entry.tvgName : entry.name || id;
  const hashByte = Number.parseInt(createHash('sha1').update(id).digest('hex').slice(0, 2), 16);
  const hue = HUE_PALETTE[hashByte % HUE_PALETTE.length];
  return {
    id,
    name,
    short: name.slice(0, 6),
    number: entry.channelNumber ?? '',
    type: inferType(entry.groupTitle),
    color: `oklch(0.58 0.11 ${hue})`,
    streamUrl: entry.streamUrl,
    source: 'm3u' as const,
    sourceId,
    m3uGroup: entry.groupTitle ?? null,
  };
}

async function upsertM3uChannels(entries: M3uEntry[], sourceId: number): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    if (!entry.streamUrl) continue;
    if (entry.streamUrl.endsWith('.m3u8')) {
      console.warn(
        `[iptv] m3u entry ${entry.name || entry.tvgId} points at .m3u8; recorder does not yet support HLS`
      );
    }
    const values = m3uToChannelValues(entry, sourceId);
    try {
      await db
        .insert(channels)
        .values(values)
        .onConflictDoUpdate({
          target: channels.id,
          set: {
            name: values.name,
            short: values.short,
            number: values.number,
            type: values.type,
            color: values.color,
            streamUrl: values.streamUrl,
            source: values.source,
            sourceId: values.sourceId,
            m3uGroup: values.m3uGroup,
          },
        });
      count++;
    } catch (err) {
      console.warn(`[iptv] upsert failed for ${values.id}:`, err);
    }
  }
  return count;
}

const XMLTV_FALLBACK_GENRE = genreFromKey('info');

function buildXmltvToInternalChannelMap(entries: M3uEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const tvgId = entry.tvgId?.trim();
    if (!tvgId) continue;
    map.set(tvgId, m3uChannelId(entry));
  }
  return map;
}

async function upsertXmltvPrograms(
  xmltvText: string,
  xmltvToInternal: Map<string, string>
): Promise<number> {
  const { programmes } = parseXmltv(xmltvText);
  if (programmes.length === 0) return 0;
  const out: Program[] = [];
  let dropped = 0;
  for (const p of programmes) {
    const ch = xmltvToInternal.get(p.channelId);
    if (!ch) { dropped++; continue; }
    out.push({
      id: `${ch}_${p.startAt}`,
      ch,
      startAt: p.startAt,
      endAt: p.endAt,
      title: p.title,
      genre: XMLTV_FALLBACK_GENRE,
      ep: p.subTitle ?? null,
      series: null,
      desc: p.desc ?? undefined,
    });
  }
  if (dropped > 0) {
    console.warn(`[iptv] xmltv: ${dropped} programme(s) skipped (unknown channel)`);
  }
  await programService.upsertMany(out);
  return out.length;
}

export class IptvProvider implements ChannelProvider {
  readonly kind: string = 'iptv';
  constructor(public readonly row: ProviderRow) {}

  async syncChannelsAndProgrammes(): Promise<SyncResult> {
    const text = await fetchText(this.row.url);
    const entries = parseM3u(text);
    const channelCount = await upsertM3uChannels(entries, this.row.id);

    if (!this.row.xmltvUrl) return { channelCount };
    try {
      const xmltv = await fetchText(this.row.xmltvUrl);
      const chMap = buildXmltvToInternalChannelMap(entries);
      const n = await upsertXmltvPrograms(xmltv, chMap);
      console.log(`[iptv] source ${this.row.id} xmltv upserted ${n} programmes`);
      return { channelCount };
    } catch (err) {
      console.warn(`[iptv] source ${this.row.id} xmltv fetch/parse failed:`, err);
      return { channelCount, warning: `xmltv: ${(err as Error).message}` };
    }
  }

  async fetchDiscover(): Promise<DiscoverInfo | null> {
    const disc = await fetchHdhomerunDiscover(this.row.url);
    if (!disc) return null;
    return {
      friendlyName: disc.friendlyName,
      model: disc.modelNumber ?? disc.modelName ?? disc.manufacturer,
      deviceId: disc.deviceId,
      tunerCount: disc.tunerCount,
    };
  }

  async fetchTunerStatuses(): Promise<TunerStatus[]> {
    const tc = this.row.tunerCount ?? 0;
    if (tc <= 0) return [];
    return fetchAllTunerStatuses(this.row.url, tc);
  }

  async probeReachable(): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REACHABILITY_TIMEOUT_MS);
    try {
      let res = await fetch(this.row.url, { method: 'HEAD', signal: ctrl.signal }).catch(() => null);
      if (!res || (!res.ok && res.status === 405)) {
        res = await fetch(this.row.url, { method: 'GET', signal: ctrl.signal }).catch(() => null);
      }
      return !!res && res.ok;
    } finally {
      clearTimeout(timer);
    }
  }

  subscribeLiveEvents(_handlers: LiveEventHandlers): MrEventStream | null {
    return null;
  }
}
