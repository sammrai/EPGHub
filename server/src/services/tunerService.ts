import type { TunerState, NowRecording } from '../schemas/tuner.ts';
import type { BcType } from '../schemas/channel.ts';
import { createMirakurunClient } from '../integrations/mirakurun/client.ts';
import type { MrTunerDevice } from '../integrations/mirakurun/types.ts';

export interface TunerService {
  list(): Promise<TunerState[]>;
  nowRecording(): Promise<NowRecording[]>;
  // Raw Mirakurun tuner device list. Used by the priority allocator
  // (services/tunerAllocator.ts) which needs the per-device `types` array
  // and physical `index`, not the bc-type aggregate `list()` returns.
  devices(): Promise<MrTunerDevice[]>;
}

export class FixtureTunerService implements TunerService {
  async list(): Promise<TunerState[]> {
    return [
      { type: 'GR', total: 4, inUse: 1 },
      { type: 'BS', total: 2, inUse: 1 },
      { type: 'CS', total: 2, inUse: 0 },
    ];
  }

  async nowRecording(): Promise<NowRecording[]> {
    const { at } = await import('../../fixtures/baseDate.ts');
    return [
      {
        id: 'nr1',
        title: '大相撲春巡業 中継',
        ch: 'nhk-g',
        startAt: at('17:00'),
        endAt: at('18:00'),
        progress: 0.72,
        series: null,
        tvdbId: null,
      },
    ];
  }

  // Fabricate a flat device list matching the aggregated totals in list().
  // The allocator only cares about types[] + index, so this is enough for
  // dev / test environments without a live Mirakurun.
  async devices(): Promise<MrTunerDevice[]> {
    const aggregates = await this.list();
    const out: MrTunerDevice[] = [];
    let idx = 0;
    for (const t of aggregates) {
      for (let i = 0; i < t.total; i++) {
        out.push({
          index: idx++,
          name: `${t.type}${i}`,
          types: [t.type],
          users: [],
          isAvailable: true,
          isRemote: false,
          isFree: true,
          isUsing: false,
          isFault: false,
        });
      }
    }
    return out;
  }
}

// Aggregate Mirakurun tuner devices into per-bc-type counts. A physical tuner
// that advertises multiple types (e.g. GR+BS combo) is counted against its
// *first* advertised type — this matches how reservations are placed and keeps
// totals consistent with tunerAvailable() in reserveService.
function aggregateTuners(devices: MrTunerDevice[]): TunerState[] {
  const counters = new Map<BcType, { total: number; inUse: number }>();
  const bump = (type: BcType, using: boolean) => {
    const cur = counters.get(type) ?? { total: 0, inUse: 0 };
    cur.total += 1;
    if (using) cur.inUse += 1;
    counters.set(type, cur);
  };
  for (const d of devices) {
    const primary = d.types[0];
    if (!primary) continue;
    // Our TunerState schema only allows GR/BS/CS; collapse SKY into CS to
    // match the channel adapter's normalisation.
    const mapped: BcType | null =
      primary === 'GR' ? 'GR' : primary === 'BS' ? 'BS' : primary === 'CS' || primary === 'SKY' ? 'CS' : null;
    if (!mapped) continue;
    const using = d.isUsing || d.users.length > 0;
    bump(mapped, using);
  }
  // Return in a deterministic GR → BS → CS order, omitting bc-types with no
  // physical tuners rather than reporting phantom 0/0 rows.
  const order: BcType[] = ['GR', 'BS', 'CS'];
  return order
    .filter((t) => counters.has(t))
    .map((t) => ({ type: t, total: counters.get(t)!.total, inUse: counters.get(t)!.inUse }));
}

export class MirakurunTunerService implements TunerService {
  private cache: { at: number; data: TunerState[] } | null = null;
  private devCache: { at: number; data: MrTunerDevice[] } | null = null;
  private readonly ttlMs = 5_000;
  private readonly fallback = new FixtureTunerService();

  async list(): Promise<TunerState[]> {
    const client = createMirakurunClient();
    if (!client) return this.fallback.list();
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.data;
    try {
      const devices = await client.tuners();
      const data = aggregateTuners(devices);
      this.cache = { at: Date.now(), data };
      this.devCache = { at: Date.now(), data: devices };
      return data;
    } catch (err) {
      console.warn('[tuners] mirakurun fetch failed, falling back to fixtures:', err);
      return this.fallback.list();
    }
  }

  async devices(): Promise<MrTunerDevice[]> {
    const client = createMirakurunClient();
    if (!client) return this.fallback.devices();
    if (this.devCache && Date.now() - this.devCache.at < this.ttlMs) return this.devCache.data;
    try {
      const devices = await client.tuners();
      this.devCache = { at: Date.now(), data: devices };
      return devices;
    } catch (err) {
      console.warn('[tuners] mirakurun devices fetch failed, falling back to fixtures:', err);
      return this.fallback.devices();
    }
  }

  async nowRecording(): Promise<NowRecording[]> {
    // Source of truth: recordings whose `state === 'recording'`. The
    // recorder module flips this flag when the Mirakurun stream actually
    // opens. We intentionally don't fall back to a time-window heuristic
    // when no rows match.
    const { recordingService } = await import('./recordingService.ts');
    let active: Awaited<ReturnType<typeof recordingService.list>>;
    try {
      active = await recordingService.list({ state: 'recording' });
    } catch (err) {
      console.warn('[tuners] nowRecording: recording list failed:', err);
      return [];
    }
    const now = Date.now();
    return active.map((r) => {
      const start = Date.parse(r.startAt);
      const end = Date.parse(r.endAt);
      const span = end - start;
      const progress = span > 0 ? Math.max(0, Math.min(1, (now - start) / span)) : 0;
      return {
        id: r.id,
        title: r.title,
        ch: r.ch,
        startAt: r.startAt,
        endAt: r.endAt,
        progress,
        series: null,
        tvdbId: null,
      };
    });
  }
}

function build(): TunerService {
  return process.env.MIRAKURUN_URL ? new MirakurunTunerService() : new FixtureTunerService();
}

export const tunerService: TunerService = build();
