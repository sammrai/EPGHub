import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { channels } from '../db/schema.ts';
import type { Channel, UpdateChannel } from '../schemas/channel.ts';

// Channel service — canonical source is the DB `channels` table, which is
// populated by channelSyncService.syncFromSource(). No live Mirakurun or
// fixture fallback: once a device is registered the DB becomes source of
// truth, and we don't silently hide / synthesize channels.

type ChannelType = 'GR' | 'BS' | 'CS';

interface ChannelRow {
  id: string;
  name: string;
  short: string;
  number: string;
  type: string;
  color: string;
  enabled: boolean;
  source: string;
}

function toApi(row: ChannelRow): Channel {
  // `type` is stored as varchar(4) but domain-wise one of GR/BS/CS. Coerce
  // with a safety default rather than crashing on unexpected values.
  const t: ChannelType =
    row.type === 'BS' || row.type === 'CS' || row.type === 'GR' ? row.type : 'GR';
  return {
    id: row.id,
    name: row.name,
    short: row.short,
    number: row.number,
    type: t,
    color: row.color,
    enabled: row.enabled,
    source: row.source,
  };
}

export interface ListOptions {
  /** Filter by the `source` field — e.g. 'mirakurun' | 'm3u'. */
  source?: string;
}

export const channelService = {
  async list(opts: ListOptions = {}): Promise<Channel[]> {
    const rows = await db.select().from(channels);
    const mapped = rows.map(toApi);
    return opts.source ? mapped.filter((c) => c.source === opts.source) : mapped;
  },

  async update(id: string, patch: UpdateChannel): Promise<Channel | null> {
    const [row] = await db
      .update(channels)
      .set({
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      })
      .where(eq(channels.id, id))
      .returning();
    return row ? toApi(row) : null;
  },
};
