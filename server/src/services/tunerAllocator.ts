// Priority-based slot tuner allocator. Adapted near-1:1 from
// `EPGStation/src/model/operator/reservation/Tuner.ts` for the per-tuner
// acceptance rules + `ReservationManageModel::createReserves` for the
// walker over the recording list.
//
// After the R0 unification the allocator operates on `Recording` rows
// (scheduled/recording/conflict are the states that still contend for
// tuner slots). Ready/failed/encoding rows never need slots.

import type { Recording } from '../schemas/recording.ts';
import type { Channel, BcType } from '../schemas/channel.ts';
import type { MrTunerDevice, MrBcType } from '../integrations/mirakurun/types.ts';

export interface AllocationResult {
  // recordingId → tunerIdx for successfully allocated rows
  allocated: Map<string, number>;
  // recordingIds that could not be placed on any tuner
  preempted: string[];
}

const PRIORITY_RANK: Record<Recording['priority'], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

// Bc-type equality between our `Channel.type` (GR/BS/CS) and Mirakurun's
// broader `MrBcType` (GR/BS/CS/SKY). We collapse SKY into CS the same way
// tunerService.aggregateTuners() does so allocation lines up with the
// `/tuners` counts shown in the UI.
function typeMatches(reserveType: BcType, tunerTypes: MrBcType[]): boolean {
  return tunerTypes.some((t) => {
    if (t === 'SKY') return reserveType === 'CS';
    return t === reserveType;
  });
}

function overlaps(a: { startAt: string; endAt: string }, b: { startAt: string; endAt: string }): boolean {
  return Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(a.endAt) > Date.parse(b.startAt);
}

// Single physical tuner slot. Near-1:1 of EPGStation's Tuner.ts: a recording
// is accepted iff its type matches and either (a) the slot is empty or
// (b) all existing rows are on the same channel (simulcast).
class TunerSlot {
  readonly idx: number;
  readonly types: MrBcType[];
  private readonly recordings: Recording[] = [];

  constructor(device: MrTunerDevice) {
    this.idx = device.index;
    this.types = device.types;
  }

  add(recording: Recording, channelType: BcType): boolean {
    if (!typeMatches(channelType, this.types)) return false;
    for (const existing of this.recordings) {
      if (existing.ch === recording.ch) continue; // simulcast OK
      if (overlaps(existing, recording)) return false;
    }
    this.recordings.push(recording);
    return true;
  }

  getRecordings(): Recording[] {
    return this.recordings.slice();
  }
}

export interface AllocateOptions {
  channels: Channel[];
}

/**
 * Walk `recordings` in priority-then-time order, greedily assigning each to
 * the first physical tuner that accepts it. The first call wins; losers
 * land in `preempted`.
 *
 * Tie-break order:
 *   1. Priority desc (high > medium > low)
 *   2. startAt asc (earlier first)
 *   3. id asc (stable)
 */
export function allocate(
  recordingsIn: Recording[],
  tuners: MrTunerDevice[],
  opts: AllocateOptions
): AllocationResult {
  const slots = tuners.map((t) => new TunerSlot(t));
  const channelType = new Map<string, BcType>();
  for (const c of opts.channels) channelType.set(c.id, c.type);

  const sorted = recordingsIn.slice().sort((a, b) => {
    const p = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (p !== 0) return p;
    const t = Date.parse(a.startAt) - Date.parse(b.startAt);
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const allocated = new Map<string, number>();
  const preempted: string[] = [];

  for (const recording of sorted) {
    const chType = channelType.get(recording.ch);
    if (!chType) {
      preempted.push(recording.id);
      continue;
    }
    let placed = false;
    for (const slot of slots) {
      if (slot.add(recording, chType)) {
        allocated.set(recording.id, slot.idx);
        placed = true;
        break;
      }
    }
    if (!placed) preempted.push(recording.id);
  }

  return { allocated, preempted };
}

/**
 * Per-slot snapshot used by the informational `GET /tuners/allocation`
 * endpoint. Mirrors `AllocationResult` but indexed by tuner.
 */
export interface SlotSnapshot {
  tunerIdx: number;
  types: MrBcType[];
  recordings: Array<{
    id: string;
    ch: string;
    startAt: string;
    endAt: string;
    priority: Recording['priority'];
    title: string;
  }>;
}

export function snapshotSlots(
  recordingsIn: Recording[],
  tuners: MrTunerDevice[],
  opts: AllocateOptions
): SlotSnapshot[] {
  const slots = tuners.map((t) => new TunerSlot(t));
  const channelType = new Map<string, BcType>();
  for (const c of opts.channels) channelType.set(c.id, c.type);

  const sorted = recordingsIn.slice().sort((a, b) => {
    const p = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (p !== 0) return p;
    const t = Date.parse(a.startAt) - Date.parse(b.startAt);
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const recording of sorted) {
    const chType = channelType.get(recording.ch);
    if (!chType) continue;
    for (const slot of slots) {
      if (slot.add(recording, chType)) break;
    }
  }

  return slots.map((s) => ({
    tunerIdx: s.idx,
    types: s.types,
    recordings: s.getRecordings().map((r) => ({
      id: r.id,
      ch: r.ch,
      startAt: r.startAt,
      endAt: r.endAt,
      priority: r.priority,
      title: r.title,
    })),
  }));
}
