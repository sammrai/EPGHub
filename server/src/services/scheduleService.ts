import { sql } from 'drizzle-orm';
import type { Program } from '../schemas/program.ts';
import type { Channel } from '../schemas/channel.ts';
import { createMirakurunClient } from '../integrations/mirakurun/client.ts';
import {
  dedupeServices,
  programToProgram,
  serviceToChannel,
} from '../integrations/mirakurun/adapter.ts';
import { channelService } from './channelService.ts';
import { programService } from './programService.ts';
import { db } from '../db/client.ts';
import { channels as channelsTable } from '../db/schema.ts';
import { useFixtures } from '../config/fixtures.ts';

export interface ScheduleService {
  /** Programs joined with TVDB entry, sourced from the DB. */
  list(): Promise<Program[]>;
  findById(id: string): Promise<Program | null>;
  /** Pull fresh EPG from Mirakurun (or fixtures) and upsert into programs. */
  refresh(): Promise<{ count: number }>;
}

class DbScheduleService implements ScheduleService {
  async list(): Promise<Program[]> {
    return programService.list();
  }

  async findById(id: string): Promise<Program | null> {
    return programService.findById(id);
  }

  async refresh(): Promise<{ count: number }> {
    const { channels, programs } = await fetchLiveFeed();
    if (channels.length > 0) await upsertChannels(channels);
    if (programs.length === 0) return { count: 0 };
    await programService.upsertMany(programs);
    // Clean up programs whose endAt is more than 24h in the past — keeps the
    // DB from growing without bound. Reserves/recorded don't reference them.
    await programService.prunePast(Date.now() - 24 * 60 * 60 * 1000);
    return { count: programs.length };
  }
}

async function upsertChannels(list: Channel[]): Promise<void> {
  const values = list.map((c, i) => ({
    id: c.id,
    name: c.name,
    short: c.short,
    number: c.number,
    type: c.type,
    color: c.color,
    enabled: true,
    sortOrder: i,
  }));
  await db
    .insert(channelsTable)
    .values(values)
    .onConflictDoUpdate({
      target: channelsTable.id,
      set: {
        name: sql`excluded.name`,
        short: sql`excluded.short`,
        number: sql`excluded.number`,
        type: sql`excluded.type`,
        color: sql`excluded.color`,
      },
    });
}

interface LiveFeed {
  channels: Channel[];
  programs: Program[];
}

async function fetchLiveFeed(): Promise<LiveFeed> {
  const client = createMirakurunClient();
  if (!client) {
    // No Mirakurun wired up. Load dev fixtures only if they're enabled —
    // otherwise leave programs/channels empty so the deployed stack starts
    // clean. Flip EPGHUB_FIXTURES=on (or unset it) to opt back in for dev.
    if (!useFixtures()) return { channels: [], programs: [] };
    const [{ PROGRAMS }, { SAMPLE_CHANNELS }] = await Promise.all([
      import('../../fixtures/programs.ts'),
      import('../../fixtures/channels.ts'),
    ]);
    return { channels: SAMPLE_CHANNELS, programs: PROGRAMS };
  }
  try {
    const [services, programs, appChannels] = await Promise.all([
      client.services(),
      client.programs(),
      channelService.list(),
    ]);
    const channelsBySvcId = new Map<number, Channel>();
    const channels: Channel[] = [];
    for (const s of dedupeServices(services)) {
      const derived = serviceToChannel(s);
      const override = appChannels.find((c) => c.id === derived.id);
      const picked = override ?? derived;
      channelsBySvcId.set(s.serviceId, picked);
      channels.push(picked);
    }
    const mapped: Program[] = [];
    for (const p of programs) {
      const mp = programToProgram(p, channelsBySvcId);
      if (mp) mapped.push(mp);
    }
    mapped.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    return { channels, programs: mapped };
  } catch (err) {
    console.warn('[schedule] mirakurun fetch failed:', err);
    return { channels: [], programs: [] };
  }
}

export const scheduleService: ScheduleService = new DbScheduleService();
