import { createHash } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { channels, channelSources } from '../db/schema.ts';
import { parseM3u, type M3uEntry } from '../integrations/m3u/parser.ts';
import { HttpMirakurunClient } from '../integrations/mirakurun/client.ts';
import { dedupeServices, serviceToChannel } from '../integrations/mirakurun/adapter.ts';
import { parseXmltv } from '../integrations/xmltv/parser.ts';
import { fetchHdhomerunDiscover } from '../integrations/hdhomerun/discover.ts';
import { scanLocalNetwork, extractPrivatePrefix } from '../integrations/hdhomerun/scan.ts';
import { programService } from './programService.ts';
import { genreFromKey } from '../lib/genreRegistry.ts';
import type {
  ChannelSource,
  ChannelSourceKind,
  ChannelSourceSyncResult,
  ProbeChannelSourceResult,
  ScanResult,
  ScannedDevice,
} from '../schemas/channelSource.ts';
import type { Program } from '../schemas/program.ts';

// -----------------------------------------------------------------
// channelSyncService — CRUD over channel_sources + a syncFromSource(id)
// that fetches each upstream and upserts into the channels table.
//
// m3u entries are mapped to channels with a `m3u-<stableId>` id so two
// sources can't collide on the same channel id. Mirakurun entries reuse
// the existing `svc-<id>` convention from the Mirakurun adapter.
//
// Kept intentionally thin — we log on partial failures rather than aborting
// the whole sync, so one malformed entry in a playlist doesn't wipe out
// the rest. last_error captures the latest failure for the admin UI.
// -----------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;

interface ChannelSourceRow {
  id: number;
  name: string;
  kind: string;
  url: string;
  xmltvUrl: string | null;
  friendlyName: string | null;
  model: string | null;
  deviceId: string | null;
  tunerCount: number | null;
  enabled: boolean;
  lastSyncAt: Date | null;
  lastError: string | null;
  channelCount: number;
  createdAt: Date;
}

function toApi(row: ChannelSourceRow): ChannelSource {
  const kind: ChannelSourceKind = row.kind === 'mirakurun' ? 'mirakurun' : 'iptv';
  return {
    id: row.id,
    name: row.name,
    kind,
    url: row.url,
    xmltvUrl: row.xmltvUrl,
    friendlyName: row.friendlyName,
    model: row.model,
    deviceId: row.deviceId,
    tunerCount: row.tunerCount,
    enabled: row.enabled,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastError: row.lastError,
    channelCount: row.channelCount,
    createdAt: row.createdAt.toISOString(),
  };
}

async function fetchWithTimeout(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Produce a stable channel id from an M3U entry so subsequent syncs
// upsert the same row rather than creating duplicates.
function m3uChannelId(entry: M3uEntry): string {
  const seed = entry.tvgId && entry.tvgId.trim().length > 0
    ? entry.tvgId.trim()
    : createHash('sha1').update(entry.streamUrl).digest('hex').slice(0, 12);
  return `m3u-${seed}`;
}

// Classify channel type from group-title where possible — we keep it best-
// effort since IPTV providers don't use a consistent scheme. Unknown buckets
// fall back to 'GR' so the existing UI filters still render the row.
function inferType(group?: string): 'GR' | 'BS' | 'CS' {
  if (!group) return 'GR';
  const g = group.toUpperCase();
  if (g.includes('BS')) return 'BS';
  if (g.includes('CS')) return 'CS';
  return 'GR';
}

const HUE_PALETTE = [28, 140, 30, 250, 260, 150, 280, 200, 220, 300, 0, 340];

function m3uToChannelValues(entry: M3uEntry): {
  id: string;
  name: string;
  short: string;
  number: string;
  type: 'GR' | 'BS' | 'CS';
  color: string;
  streamUrl: string;
  source: 'm3u';
  m3uGroup: string | null;
} {
  const id = m3uChannelId(entry);
  const name = entry.tvgName && entry.tvgName.length > 0 ? entry.tvgName : entry.name || id;
  // Hash-based deterministic hue so logo-less channels at least get a
  // stable accent color across reboots.
  const hashByte = Number.parseInt(
    createHash('sha1').update(id).digest('hex').slice(0, 2),
    16
  );
  const hue = HUE_PALETTE[hashByte % HUE_PALETTE.length];
  return {
    id,
    name,
    short: name.slice(0, 6),
    number: entry.channelNumber ?? '',
    type: inferType(entry.groupTitle),
    color: `oklch(0.58 0.11 ${hue})`,
    streamUrl: entry.streamUrl,
    source: 'm3u',
    m3uGroup: entry.groupTitle ?? null,
  };
}

// XMLTV <channel id="..."> values map 1:1 to m3u tvgId. Build a lookup
// from the same M3uEntry[] we used to upsert channels so we can rewrite
// incoming XMLTV programmes to our internal `m3u-<tvgId>` channel ids.
function buildXmltvToInternalChannelMap(entries: M3uEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const tvgId = entry.tvgId?.trim();
    if (!tvgId) continue;
    map.set(tvgId, m3uChannelId(entry));
  }
  return map;
}

const XMLTV_FALLBACK_GENRE = genreFromKey('info');

// Given a device URL, return a best-guess XMLTV feed URL for known providers.
// Mirakurun    /api/iptv         → /api/iptv/xmltv
// EPGStation   /api/iptv/channel.m3u8?... → /api/iptv/epg.xml?isHalfWidth=true&days=3
// others → null (user supplies manually)
export function deriveSuggestedXmltvUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const p = u.pathname.toLowerCase();
    if (p.endsWith('/api/iptv/channel.m3u8')) {
      const out = new URL(rawUrl);
      out.pathname = u.pathname.replace(/channel\.m3u8$/i, 'epg.xml');
      out.searchParams.delete('mode');
      if (!out.searchParams.has('days')) out.searchParams.set('days', '3');
      return out.toString();
    }
    if (p.endsWith('/api/iptv') || p.endsWith('/api/iptv/')) {
      return `${rawUrl.replace(/\/+$/, '')}/xmltv`;
    }
  } catch {}
  return null;
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
    if (!ch) {
      // XMLTV references a channel we didn't register from m3u — skip it
      // rather than creating an orphan program row (the `ch` FK would fail).
      dropped++;
      continue;
    }
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
    console.warn(`[channelSync] xmltv: ${dropped} programme(s) skipped (unknown channel)`);
  }
  await programService.upsertMany(out);
  return out.length;
}

async function upsertM3uChannels(entries: M3uEntry[]): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    if (!entry.streamUrl) continue;
    if (entry.streamUrl.endsWith('.m3u8')) {
      // HLS upstream — stored for visibility but recorder will fail on it.
      // Flag it in the log so the operator knows to pick a raw-TS variant.
      console.warn(
        `[channelSync] m3u entry ${entry.name || entry.tvgId} points at .m3u8; recorder does not yet support HLS`
      );
    }
    const values = m3uToChannelValues(entry);
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
            m3uGroup: values.m3uGroup,
          },
        });
      count++;
    } catch (err) {
      console.warn(`[channelSync] upsert failed for ${values.id}:`, err);
    }
  }
  return count;
}

async function syncMirakurun(url: string): Promise<number> {
  const base = url.replace(/\/$/, '');
  const client = new HttpMirakurunClient(base);
  const services = await client.services();
  const deduped = dedupeServices(services);
  let count = 0;
  for (const svc of deduped) {
    const mapped = serviceToChannel(svc);
    const streamUrl = `${base}/api/services/${svc.id}/stream`;
    try {
      await db
        .insert(channels)
        .values({
          id: mapped.id,
          name: mapped.name,
          short: mapped.short,
          number: mapped.number,
          type: mapped.type,
          color: mapped.color,
          streamUrl,
          source: 'mirakurun',
          m3uGroup: null,
        })
        .onConflictDoUpdate({
          target: channels.id,
          set: {
            name: mapped.name,
            short: mapped.short,
            number: mapped.number,
            type: mapped.type,
            color: mapped.color,
            streamUrl,
            source: 'mirakurun',
          },
        });
      count++;
    } catch (err) {
      console.warn(`[channelSync] mirakurun upsert failed for ${mapped.id}:`, err);
    }
  }
  return count;
}

export const channelSyncService = {
  async list(): Promise<ChannelSource[]> {
    const rows = await db
      .select()
      .from(channelSources)
      .orderBy(desc(channelSources.createdAt));
    return rows.map(toApi);
  },

  async create(input: {
    name: string;
    kind: ChannelSourceKind;
    url: string;
    xmltvUrl?: string | null;
  }): Promise<ChannelSource> {
    // Idempotent: if the URL is already registered, return the existing row
    // (and patch the xmltv_url if the caller provided a newer one) rather
    // than silently creating a duplicate. Scan-and-click UX can trigger
    // repeated submits; dedupe at the storage boundary is the cleanest fix.
    const [existing] = await db
      .select()
      .from(channelSources)
      .where(eq(channelSources.url, input.url))
      .limit(1);
    if (existing) {
      const wantXmltv = input.kind === 'iptv' ? input.xmltvUrl ?? null : null;
      if (wantXmltv && wantXmltv !== existing.xmltvUrl) {
        const [patched] = await db
          .update(channelSources)
          .set({ xmltvUrl: wantXmltv })
          .where(eq(channelSources.id, existing.id))
          .returning();
        return toApi(patched);
      }
      return toApi(existing);
    }
    const [row] = await db
      .insert(channelSources)
      .values({
        name: input.name,
        kind: input.kind,
        url: input.url,
        xmltvUrl: input.kind === 'iptv' ? input.xmltvUrl ?? null : null,
      })
      .returning();
    return toApi(row);
  },

  async remove(id: number): Promise<boolean> {
    const res = await db.delete(channelSources).where(eq(channelSources.id, id)).returning();
    return res.length > 0;
  },

  async syncFromSource(id: number): Promise<ChannelSourceSyncResult> {
    const [row] = await db.select().from(channelSources).where(eq(channelSources.id, id)).limit(1);
    if (!row) return { channelCount: 0, error: 'not found' };

    let channelCount = 0;
    let error: string | undefined;
    try {
      if (row.kind === 'iptv') {
        const text = await fetchWithTimeout(row.url);
        const entries = parseM3u(text);
        channelCount = await upsertM3uChannels(entries);
        // Optional XMLTV guide: pull after channels are in place so the
        // programme-row foreign key (ch → channels.id) resolves. Failures
        // here are logged as partial errors rather than aborting the sync.
        if (row.xmltvUrl) {
          try {
            const xmltv = await fetchWithTimeout(row.xmltvUrl);
            const chMap = buildXmltvToInternalChannelMap(entries);
            const n = await upsertXmltvPrograms(xmltv, chMap);
            console.log(`[channelSync] source ${id} xmltv upserted ${n} programmes`);
          } catch (xmlErr) {
            error = `xmltv: ${(xmlErr as Error).message}`;
            console.warn(`[channelSync] source ${id} xmltv fetch/parse failed:`, xmlErr);
          }
        }
        // Best-effort HDHomeRun discover — tells us FriendlyName, ModelNumber,
        // TunerCount, DeviceID. Providers that don't implement it (plain m3u
        // playlists) return null and we just leave the metadata fields alone.
        const disc = await fetchHdhomerunDiscover(row.url);
        if (disc) {
          await db
            .update(channelSources)
            .set({
              friendlyName: disc.friendlyName,
              model: disc.modelNumber ?? disc.modelName ?? disc.manufacturer,
              deviceId: disc.deviceId,
              tunerCount: disc.tunerCount,
            })
            .where(eq(channelSources.id, id));
        }
      } else if (row.kind === 'mirakurun') {
        channelCount = await syncMirakurun(row.url);
      } else {
        throw new Error(`unknown source kind: ${row.kind}`);
      }
    } catch (err) {
      error = (err as Error)?.message ?? String(err);
      console.warn(`[channelSync] source ${id} (${row.kind}) failed:`, err);
    }

    await db
      .update(channelSources)
      .set({
        lastSyncAt: new Date(),
        lastError: error ?? null,
        channelCount,
      })
      .where(eq(channelSources.id, id));

    return error ? { channelCount, error } : { channelCount };
  },

  // Auto-probe a prospective m3u URL before the user saves the device.
  // Tries HDHomeRun /discover.json for metadata, and heuristically suggests
  // a matching XMLTV URL based on known URL patterns:
  //   Mirakurun base  /api/iptv        → /api/iptv/xmltv
  //   EPGStation      /api/iptv/channel.m3u8?... → /api/iptv/epg.xml?isHalfWidth=true&days=3
  //   anything else   → null (user types it manually)
  // Runs cheap probes — no writes.
  async probe(rawUrl: string): Promise<ProbeChannelSourceResult> {
    const url = rawUrl.trim();
    const disc = await fetchHdhomerunDiscover(url).catch(() => null);

    const suggestedXmltvUrl = deriveSuggestedXmltvUrl(url);
    let inferredKind: string | null = null;
    try {
      const p = new URL(url).pathname.toLowerCase();
      if (p.endsWith('/api/iptv/channel.m3u8')) inferredKind = 'EPGStation';
      else if (p.endsWith('/api/iptv') || p.endsWith('/api/iptv/')) inferredKind = 'Mirakurun';
    } catch {}

    // Discover payload refines the kind label when available.
    if (disc?.friendlyName) {
      const fn = disc.friendlyName.toLowerCase();
      if (fn.includes('mirakurun')) inferredKind = inferredKind ?? 'Mirakurun';
      else if (fn.includes('epgstation')) inferredKind = inferredKind ?? 'EPGStation';
    }

    return {
      reachable: !!disc,
      friendlyName: disc?.friendlyName ?? null,
      model: disc?.modelNumber ?? disc?.modelName ?? disc?.manufacturer ?? null,
      tunerCount: disc?.tunerCount ?? null,
      suggestedXmltvUrl,
      inferredKind,
    };
  },

  // LAN scan — walk the server's local subnets on a priority-ordered set
  // of (port, path) candidates and return every HDHomeRun-speaking device
  // we can reach. Each result already includes a best-guess XMLTV URL so
  // the UI can offer one-click add.
  async scan(): Promise<ScanResult> {
    // Mirror the SSE path's hint behavior for the non-streaming fallback.
    const hints = new Set<string>();
    const rows = await db.select().from(channelSources);
    for (const r of rows) {
      const p = extractPrivatePrefix(r.url);
      if (p) hints.add(p);
    }
    const raw = await scanLocalNetwork({ extraPrefixes: Array.from(hints) });
    const devices: ScannedDevice[] = raw.map((d) => ({
      kind: d.kind,
      url: d.url,
      friendlyName: d.friendlyName,
      model: d.model,
      tunerCount: d.tunerCount,
      label: d.label,
      // The probe itself now carries xmltv for EPGStation; fall back to the
      // URL-pattern heuristic for anything else (future providers).
      suggestedXmltvUrl: d.xmltvUrl ?? deriveSuggestedXmltvUrl(d.url),
    }));
    return { devices };
  },

  // Seed an iptv row on first boot if MIRAKURUN_URL is set and no rows
  // exist yet. We now register Mirakurun *as* an IPTV/HDHomeRun device —
  // its /api/iptv endpoint speaks the HDHomeRun protocol, so the same
  // sync/discover/tuner-status code paths work. Mirakurun-specific
  // overlays (SSE, ARIB extended) layer on top when available.
  async seedFromEnvIfEmpty(): Promise<void> {
    const mirakurunUrl = process.env.MIRAKURUN_URL;
    if (!mirakurunUrl) return;
    const existing = await db.select().from(channelSources).limit(1);
    if (existing.length > 0) return;
    const base = mirakurunUrl.replace(/\/+$/, '');
    await db.insert(channelSources).values({
      name: 'Mirakurun (env)',
      kind: 'iptv',
      url: `${base}/api/iptv`,
      xmltvUrl: `${base}/api/iptv/xmltv`,
    });
  },
};
