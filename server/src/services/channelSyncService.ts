import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { channelSources } from '../db/schema.ts';
import { fetchHdhomerunDiscover } from '../integrations/hdhomerun/discover.ts';
import { scanLocalNetwork, extractPrivatePrefix } from '../integrations/hdhomerun/scan.ts';
import { createProvider } from '../providers/registry.ts';
import type {
  ChannelSource,
  ChannelSourceKind,
  ChannelSourceSyncResult,
  ProbeChannelSourceResult,
  ScanResult,
  ScannedDevice,
} from '../schemas/channelSource.ts';

// -----------------------------------------------------------------
// channelSyncService — CRUD over channel_sources + a syncFromSource(id)
// that delegates to providers/ (IptvProvider / MirakurunProvider) for
// the actual fetch/parse/upsert. All kind-specific code lives behind
// createProvider(); this module only deals with persistence + admin UX
// (scan/probe/seed).
// -----------------------------------------------------------------

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

// Given a device URL, return a best-guess XMLTV feed URL for Mirakurun-style
// providers (/api/iptv → /api/iptv/xmltv). Anything else → null; the user
// supplies the XMLTV URL manually.
export function deriveSuggestedXmltvUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const p = u.pathname.toLowerCase();
    if (p.endsWith('/api/iptv') || p.endsWith('/api/iptv/')) {
      return `${rawUrl.replace(/\/+$/, '')}/xmltv`;
    }
  } catch {}
  return null;
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

    const provider = createProvider(row);
    let channelCount = 0;
    let error: string | undefined;
    try {
      const result = await provider.syncChannelsAndProgrammes();
      channelCount = result.channelCount;
      if (result.warning) error = result.warning;

      // Best-effort discover — populates FriendlyName, ModelNumber,
      // TunerCount, DeviceID so the Device modal can show hardware state.
      // Providers without HDHomeRun support return null.
      const disc = await provider.fetchDiscover();
      if (disc) {
        await db
          .update(channelSources)
          .set({
            friendlyName: disc.friendlyName,
            model: disc.model,
            deviceId: disc.deviceId,
            tunerCount: disc.tunerCount,
          })
          .where(eq(channelSources.id, id));
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
  // Tries HDHomeRun /discover.json for metadata, and suggests an XMLTV URL
  // for the /api/iptv → /api/iptv/xmltv pattern. `inferredKind` is Mirakurun
  // when the discover payload self-identifies; anything else gets null so
  // the operator picks a kind manually.
  async probe(rawUrl: string): Promise<ProbeChannelSourceResult> {
    const url = rawUrl.trim();
    const disc = await fetchHdhomerunDiscover(url).catch(() => null);

    const suggestedXmltvUrl = deriveSuggestedXmltvUrl(url);
    let inferredKind: string | null = null;
    try {
      const p = new URL(url).pathname.toLowerCase();
      if (p.endsWith('/api/iptv') || p.endsWith('/api/iptv/')) inferredKind = 'Mirakurun';
    } catch {}

    if (disc?.friendlyName) {
      const fn = disc.friendlyName.toLowerCase();
      if (fn.includes('mirakurun')) inferredKind = inferredKind ?? 'Mirakurun';
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
      // The scanner may have already derived an xmltv URL; fall back to the
      // URL-pattern heuristic for anything else.
      suggestedXmltvUrl: d.xmltvUrl ?? deriveSuggestedXmltvUrl(d.url),
    }));
    return { devices };
  },

  // Seed a Mirakurun row on first boot if MIRAKURUN_URL is set and no rows
  // exist yet. Registered as kind='mirakurun' so MirakurunProvider takes
  // over (rich JSON APIs for channels/programmes/tuners/SSE) rather than
  // the m3u-based IPTV fallback.
  async seedFromEnvIfEmpty(): Promise<void> {
    const mirakurunUrl = process.env.MIRAKURUN_URL;
    if (!mirakurunUrl) return;
    const existing = await db.select().from(channelSources).limit(1);
    if (existing.length > 0) return;
    const base = mirakurunUrl.replace(/\/+$/, '');
    await db.insert(channelSources).values({
      name: 'Mirakurun (env)',
      kind: 'mirakurun',
      url: base,
      xmltvUrl: null,
    });
  },
};
