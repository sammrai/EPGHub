import { createHash } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { channels, channelSources } from '../db/schema.ts';
import { parseM3u, type M3uEntry } from '../integrations/m3u/parser.ts';
import { HttpMirakurunClient } from '../integrations/mirakurun/client.ts';
import { dedupeServices, serviceToChannel } from '../integrations/mirakurun/adapter.ts';
import type {
  ChannelSource,
  ChannelSourceKind,
  ChannelSourceSyncResult,
} from '../schemas/channelSource.ts';

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
  enabled: boolean;
  lastSyncAt: Date | null;
  lastError: string | null;
  channelCount: number;
  createdAt: Date;
}

function toApi(row: ChannelSourceRow): ChannelSource {
  return {
    id: row.id,
    name: row.name,
    kind: (row.kind === 'm3u' ? 'm3u' : 'mirakurun') as ChannelSourceKind,
    url: row.url,
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
  }): Promise<ChannelSource> {
    const [row] = await db
      .insert(channelSources)
      .values({
        name: input.name,
        kind: input.kind,
        url: input.url,
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
      if (row.kind === 'm3u') {
        const text = await fetchWithTimeout(row.url);
        const entries = parseM3u(text);
        channelCount = await upsertM3uChannels(entries);
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

  // Seed a mirakurun row on first boot if MIRAKURUN_URL is set and no rows
  // exist yet. Keeps the env-driven path working for users who haven't
  // migrated to the source-registration UI. Idempotent.
  async seedFromEnvIfEmpty(): Promise<void> {
    const mirakurunUrl = process.env.MIRAKURUN_URL;
    if (!mirakurunUrl) return;
    const existing = await db.select().from(channelSources).limit(1);
    if (existing.length > 0) return;
    await db.insert(channelSources).values({
      name: 'Mirakurun (env)',
      kind: 'mirakurun',
      url: mirakurunUrl,
    });
  },
};
