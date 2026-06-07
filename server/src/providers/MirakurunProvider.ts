// MirakurunProvider — IPTV + Mirakurun-native high-bandwidth APIs.
//
// Extends IptvProvider and overrides the methods where Mirakurun ships a
// richer endpoint than the HDHomeRun emulation:
//   * syncChannelsAndProgrammes → /api/services + /api/programs (ARIB-aware,
//                                  preserves extended attrs, no XMLTV round-trip).
//   * fetchTunerStatuses        → /api/tuners (true per-tuner channel name + client id).
//   * subscribeLiveEvents       → /api/events/stream (EIT[p/f] live updates).
//   * fetchDiscover             → /api/iptv/discover.json (fixed path; no path-guess heuristic).
//
// Inherits IptvProvider's xmltv plumbing for completeness but does not invoke
// it (we already have richer programme data from /api/programs).

import { db } from '../db/client.ts';
import { channels as channelsTable } from '../db/schema.ts';
import {
  HttpMirakurunClient,
  type MrEventStream,
} from '../integrations/mirakurun/client.ts';
import { dedupeServices, serviceToChannel, programToProgram } from '../integrations/mirakurun/adapter.ts';
import { fetchMirakurunTunerStatuses } from '../integrations/mirakurun/tunerStatus.ts';
import { parseDiscover } from '../integrations/hdhomerun/discover.ts';
import { programService } from '../services/programService.ts';
import type { Channel } from '../schemas/channel.ts';
import type { Program } from '../schemas/program.ts';
import { IptvProvider } from './IptvProvider.ts';
import type { DiscoverInfo, LiveEventHandlers, SyncResult, TunerStatus } from './types.ts';

const DISCOVER_TIMEOUT_MS = 5_000;
const REACHABILITY_TIMEOUT_MS = 3_000;

export class MirakurunProvider extends IptvProvider {
  readonly kind = 'mirakurun';

  private get baseUrl(): string {
    return this.row.url.replace(/\/+$/, '');
  }

  private client(): HttpMirakurunClient {
    return new HttpMirakurunClient(this.baseUrl);
  }

  async syncChannelsAndProgrammes(): Promise<SyncResult> {
    const client = this.client();
    const [services, mrPrograms] = await Promise.all([
      client.services(),
      client.programs().catch((err) => {
        console.warn(`[mirakurun] source ${this.row.id} /api/programs failed:`, err);
        return [];
      }),
    ]);

    const channelsBySvcId = new Map<number, Channel>();
    let channelCount = 0;
    for (const svc of dedupeServices(services)) {
      const mapped = serviceToChannel(svc);
      const streamUrl = `${this.baseUrl}/api/services/${svc.id}/stream`;
      try {
        await db
          .insert(channelsTable)
          .values({
            id: mapped.id,
            name: mapped.name,
            short: mapped.short,
            number: mapped.number,
            type: mapped.type,
            color: mapped.color,
            streamUrl,
            source: 'mirakurun',
            sourceId: this.row.id,
            m3uGroup: null,
          })
          .onConflictDoUpdate({
            target: channelsTable.id,
            set: {
              name: mapped.name,
              short: mapped.short,
              number: mapped.number,
              type: mapped.type,
              color: mapped.color,
              streamUrl,
              source: 'mirakurun',
              sourceId: this.row.id,
            },
          });
        channelsBySvcId.set(svc.serviceId, mapped);
        channelCount++;
      } catch (err) {
        console.warn(`[mirakurun] upsert failed for ${mapped.id}:`, err);
      }
    }

    if (mrPrograms.length > 0 && channelsBySvcId.size > 0) {
      const programs: Program[] = [];
      for (const p of mrPrograms) {
        const mp = programToProgram(p, channelsBySvcId);
        if (mp) programs.push(mp);
      }
      if (programs.length > 0) {
        programs.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
        await programService.upsertMany(programs);
        await programService.prunePast(Date.now() - 24 * 60 * 60 * 1000);
        console.log(`[mirakurun] source ${this.row.id} upserted ${programs.length} programmes`);
      }
    }

    return { channelCount };
  }

  async fetchDiscover(): Promise<DiscoverInfo | null> {
    const url = `${this.baseUrl}/api/iptv/discover.json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DISCOVER_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const disc = parseDiscover(await res.text());
      return {
        friendlyName: disc.friendlyName,
        model: disc.modelNumber ?? disc.modelName ?? disc.manufacturer,
        deviceId: disc.deviceId,
        tunerCount: disc.tunerCount,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchTunerStatuses(): Promise<TunerStatus[]> {
    return fetchMirakurunTunerStatuses(this.baseUrl);
  }

  async probeReachable(): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REACHABILITY_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, { signal: ctrl.signal }).catch(() => null);
      return !!res && res.ok;
    } finally {
      clearTimeout(timer);
    }
  }

  subscribeLiveEvents(handlers: LiveEventHandlers): MrEventStream {
    return this.client().eventsStream(handlers);
  }
}
