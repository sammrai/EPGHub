import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { programs, recordings } from '../db/schema.ts';
import { createMirakurunClient, type MrEvent, type MrEventStream } from '../integrations/mirakurun/client.ts';
import { rescheduleStop } from '../recording/recorder.ts';
import type { MrProgram } from '../integrations/mirakurun/types.ts';
import {
  diffProgramUpdate,
  type DiffAction,
  type IncomingProgram,
  type RecordingForDiff,
  type StoredProgram,
} from './epgLiveDiff.ts';

// -----------------------------------------------------------------
// Live EIT[p/f] ingestion.
//
// Mirakurun streams EPG updates via GET /events/stream. We only care
// about program-update events that touch a program we already have a
// recording row on, so we can shift the RECORD_STOP pg-boss job when
// the broadcaster extends a program (e.g. sports overrun).
//
// The pure diff logic lives in epgLiveDiff.ts so it can be unit-tested
// without pulling in the DB/boss/SSE runtime.
// -----------------------------------------------------------------

export { diffProgramUpdate };
export type { DiffAction, IncomingProgram, RecordingForDiff, StoredProgram };

/**
 * Apply a single batch of diff actions within one transaction. Returns the
 * recording ids that had their end time shifted so the caller can log.
 */
export async function applyDiffActions(actions: DiffAction[]): Promise<string[]> {
  if (actions.length === 0) return [];
  const shifted: string[] = [];

  for (const a of actions) {
    if (a.type === 'bumpProgramRevision') {
      await db.update(programs)
        .set({
          startAt: new Date(a.newStartAt),
          endAt: new Date(a.newEndAt),
          revision: sql`${programs.revision} + 1`,
        })
        .where(eq(programs.id, a.programId))
        .catch((err) => console.warn('[epg.live] bumpProgramRevision failed:', err));
      continue;
    }

    const prevEndMs = Date.parse(a.prevEndAt);
    const newEndMs = Date.parse(a.newEndAt);
    const deltaSec = Math.round((newEndMs - prevEndMs) / 1000);
    const set: Record<string, unknown> = {
      endAt: new Date(a.newEndAt),
      extendedBySec: sql`${recordings.extendedBySec} + ${deltaSec}`,
    };
    if (a.captureOriginal) {
      set.originalEndAt = new Date(a.prevEndAt);
    }

    await db.update(recordings).set(set).where(eq(recordings.id, a.recordingId));

    try {
      await rescheduleStop(a.recordingId, a.newEndAt);
    } catch (err) {
      console.warn(`[epg.live] rescheduleStop(${a.recordingId}) failed:`, err);
    }
    shifted.push(a.recordingId);
  }

  return shifted;
}

/**
 * Re-fetch the freshest state for a set of program ids, diff against DB,
 * apply. Used by both the SSE handler and the polling fallback worker.
 */
export async function refreshProgramsByIds(
  input: Array<{ id: string; startAtMs: number; durationMs: number }>
): Promise<{ shifted: string[]; touched: number }> {
  if (input.length === 0) return { shifted: [], touched: 0 };

  const ids = input.map((p) => p.id);
  const [storedRows, recordingRows] = await Promise.all([
    db.select({ id: programs.id, startAt: programs.startAt, endAt: programs.endAt })
      .from(programs)
      .where(inArray(programs.id, ids)),
    db.select({
      id: recordings.id,
      programId: recordings.programId,
      startAt: recordings.startAt,
      endAt: recordings.endAt,
      state: recordings.state,
      marginPost: recordings.marginPost,
      originalStartAt: recordings.originalStartAt,
      originalEndAt: recordings.originalEndAt,
      extendedBySec: recordings.extendedBySec,
    })
      .from(recordings)
      .where(and(
        inArray(recordings.programId, ids),
        inArray(recordings.state, ['scheduled', 'recording'])
      )),
  ]);

  const storedById = new Map(storedRows.map((r) => [r.id, r]));
  const recordingsByProgramId = new Map<string, RecordingForDiff[]>();
  for (const r of recordingRows) {
    const list = recordingsByProgramId.get(r.programId) ?? [];
    list.push({
      id: r.id,
      programId: r.programId,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      state: r.state,
      marginPost: r.marginPost,
      originalStartAt: r.originalStartAt?.toISOString() ?? null,
      originalEndAt: r.originalEndAt?.toISOString() ?? null,
      extendedBySec: r.extendedBySec,
    });
    recordingsByProgramId.set(r.programId, list);
  }

  const allActions: DiffAction[] = [];
  for (const incoming of input) {
    const stored = storedById.get(incoming.id);
    if (!stored) continue;
    const newStart = new Date(incoming.startAtMs).toISOString();
    const newEnd = new Date(incoming.startAtMs + incoming.durationMs).toISOString();
    const actions = diffProgramUpdate(
      { id: stored.id, startAt: stored.startAt.toISOString(), endAt: stored.endAt.toISOString() },
      { id: incoming.id, startAt: newStart, endAt: newEnd },
      recordingsByProgramId.get(incoming.id) ?? []
    );
    allActions.push(...actions);
  }

  const shifted = await applyDiffActions(allActions);
  return { shifted, touched: allActions.length };
}

// -----------------------------------------------------------------
// Mirakurun program-id → epghub program-id mapping.
// -----------------------------------------------------------------

export function mirakurunProgramToKey(p: MrProgram, serviceIdToChId: Map<number, string>): {
  programId: string;
  startAtMs: number;
  durationMs: number;
} | null {
  const ch = serviceIdToChId.get(p.serviceId);
  if (!ch) return null;
  const startAtIso = new Date(p.startAt).toISOString();
  return {
    programId: `${ch}_${startAtIso}`,
    startAtMs: p.startAt,
    durationMs: p.duration,
  };
}

// -----------------------------------------------------------------
// Live service singleton.
// -----------------------------------------------------------------

interface EpgLiveServiceState {
  stream: MrEventStream | null;
  stopRequested: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  backoffMs: number;
  serviceIdToChId: Map<number, string>;
  pending: Map<string, { startAtMs: number; durationMs: number }>;
  flushTimer: NodeJS.Timeout | null;
  connected: boolean;
  connecting: boolean;
}

const state: EpgLiveServiceState = {
  stream: null,
  stopRequested: false,
  reconnectTimer: null,
  backoffMs: 1000,
  serviceIdToChId: new Map(),
  pending: new Map(),
  flushTimer: null,
  connected: false,
  connecting: false,
};

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const FLUSH_INTERVAL_MS = 2_000;

export function isConnected(): boolean {
  return state.connected;
}

export async function start(): Promise<void> {
  const client = createMirakurunClient();
  if (!client) {
    console.log('[epg.live] MIRAKURUN_URL not set — SSE disabled (polling fallback only)');
    return;
  }
  state.stopRequested = false;
  await warmServiceMap();
  connect();
}

export async function stop(): Promise<void> {
  state.stopRequested = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  state.stream?.close();
  state.stream = null;
  state.connected = false;
  state.connecting = false;
  await flushPending();
}

async function warmServiceMap(): Promise<void> {
  try {
    const { channelService } = await import('./channelService.ts');
    const channels = await channelService.list();
    state.serviceIdToChId.clear();
    for (const c of channels) {
      const m = c.id.match(/^svc-(\d+)$/);
      if (m) {
        const num = Number(m[1]);
        if (Number.isFinite(num)) state.serviceIdToChId.set(num, c.id);
      }
    }
  } catch (err) {
    console.warn('[epg.live] warmServiceMap failed (continuing):', err);
  }
}

function connect(): void {
  if (state.stopRequested) return;
  if (state.connecting) return;
  if (state.stream) {
    try { state.stream.close(); } catch { /* ignore */ }
    state.stream = null;
  }
  state.connected = false;

  const client = createMirakurunClient();
  if (!client) return;

  state.connecting = true;
  let thisStream: MrEventStream | null = null;
  const isCurrent = () => thisStream !== null && state.stream === thisStream;

  thisStream = client.eventsStream({
    onOpen: () => {
      if (!isCurrent()) return;
      state.connecting = false;
      state.connected = true;
      state.backoffMs = INITIAL_BACKOFF_MS;
      console.log('[epg.live] SSE connected');
      if (!state.flushTimer) {
        state.flushTimer = setInterval(() => {
          void flushPending().catch((err) =>
            console.warn('[epg.live] flushPending error:', err)
          );
        }, FLUSH_INTERVAL_MS);
      }
    },
    onEvent: (ev) => {
      if (state.stopRequested) return;
      if (!isCurrent()) return;
      handleEvent(ev);
    },
    onError: (err) => {
      if (!isCurrent()) return;
      state.connecting = false;
      state.connected = false;
      state.stream = null;
      if (state.stopRequested) return;
      console.warn('[epg.live] SSE error:', (err as Error)?.message ?? err);
      scheduleReconnect();
    },
  });
  state.stream = thisStream;
}

function scheduleReconnect(): void {
  if (state.stopRequested) return;
  if (state.reconnectTimer) return;
  const delay = state.backoffMs;
  console.log(`[epg.live] reconnecting in ${delay}ms`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
    connect();
  }, delay);
}

function handleEvent(ev: MrEvent): void {
  if (ev.resource !== 'program') return;
  if (ev.type !== 'update' && ev.type !== 'create') return;
  const data = ev.data as MrProgram | undefined;
  if (!data || typeof data.id !== 'number' || typeof data.serviceId !== 'number') return;
  const mapped = mirakurunProgramToKey(data, state.serviceIdToChId);
  if (!mapped) return;
  state.pending.set(mapped.programId, {
    startAtMs: mapped.startAtMs,
    durationMs: mapped.durationMs,
  });
}

async function flushPending(): Promise<void> {
  if (state.pending.size === 0) return;
  const entries = Array.from(state.pending.entries()).map(([id, v]) => ({
    id,
    startAtMs: v.startAtMs,
    durationMs: v.durationMs,
  }));
  state.pending.clear();
  try {
    const { shifted, touched } = await refreshProgramsByIds(entries);
    if (shifted.length > 0) {
      console.log(`[epg.live] applied ${touched} actions, shifted recordings: ${shifted.join(',')}`);
    }
  } catch (err) {
    console.warn('[epg.live] flushPending failed:', err);
  }
}

// -----------------------------------------------------------------
// Polling fallback (QUEUE.EPG_LIVE_POLL).
// -----------------------------------------------------------------

export async function pollOnce(
  opts: { horizonMs?: number; source?: 'auto' | 'programs-table' } = {}
): Promise<{ shifted: string[]; touched: number }> {
  const horizon = opts.horizonMs ?? 6 * 60 * 60 * 1000; // 6h window
  const now = new Date();
  const until = new Date(now.getTime() + horizon);

  const relevantRecordings = await db.select({
    programId: recordings.programId,
  }).from(recordings)
    .where(and(
      inArray(recordings.state, ['scheduled', 'recording']),
      gt(recordings.endAt, now),
    ));
  if (relevantRecordings.length === 0) return { shifted: [], touched: 0 };

  const programIds = Array.from(new Set(relevantRecordings.map((r) => r.programId)));

  if (opts.source === 'programs-table') {
    return syncRecordingsFromProgramsTable(programIds);
  }

  const client = createMirakurunClient();
  if (!client) {
    return syncRecordingsFromProgramsTable(programIds);
  }

  let mrPrograms: MrProgram[];
  try {
    mrPrograms = await client.programs();
  } catch (err) {
    console.warn('[epg.live] poll fetch failed:', err);
    return syncRecordingsFromProgramsTable(programIds);
  }
  if (state.serviceIdToChId.size === 0) await warmServiceMap();

  const input = [] as Array<{ id: string; startAtMs: number; durationMs: number }>;
  const needed = new Set(programIds);
  for (const p of mrPrograms) {
    const k = mirakurunProgramToKey(p, state.serviceIdToChId);
    if (!k) continue;
    if (!needed.has(k.programId)) continue;
    input.push({ id: k.programId, startAtMs: k.startAtMs, durationMs: k.durationMs });
    if (p.startAt > until.getTime()) continue;
  }

  return refreshProgramsByIds(input);
}

/**
 * Fallback sync path used when Mirakurun isn't reachable. Compares each
 * recording's endAt against the programs row it references and, if they
 * disagree, drives rescheduleStop as if the program had been extended.
 */
async function syncRecordingsFromProgramsTable(programIds: string[]): Promise<{ shifted: string[]; touched: number }> {
  if (programIds.length === 0) return { shifted: [], touched: 0 };

  const rows = await db
    .select({
      rId: recordings.id,
      rProgramId: recordings.programId,
      rStartAt: recordings.startAt,
      rEndAt: recordings.endAt,
      rState: recordings.state,
      rMarginPost: recordings.marginPost,
      rOriginalStartAt: recordings.originalStartAt,
      rOriginalEndAt: recordings.originalEndAt,
      rExtendedBySec: recordings.extendedBySec,
      pStartAt: programs.startAt,
      pEndAt: programs.endAt,
    })
    .from(recordings)
    .innerJoin(programs, eq(programs.id, recordings.programId))
    .where(and(
      inArray(recordings.programId, programIds),
      inArray(recordings.state, ['scheduled', 'recording']),
    ));

  const actions: DiffAction[] = [];
  for (const r of rows) {
    const stored: StoredProgram = {
      id: r.rProgramId,
      startAt: r.rStartAt.toISOString(),
      endAt: r.rEndAt.toISOString(),
    };
    const incoming: IncomingProgram = {
      id: r.rProgramId,
      startAt: r.pStartAt.toISOString(),
      endAt: r.pEndAt.toISOString(),
    };
    const recordingDiff: RecordingForDiff = {
      id: r.rId,
      programId: r.rProgramId,
      startAt: r.rStartAt.toISOString(),
      endAt: r.rEndAt.toISOString(),
      state: r.rState,
      marginPost: r.rMarginPost,
      originalStartAt: r.rOriginalStartAt?.toISOString() ?? null,
      originalEndAt: r.rOriginalEndAt?.toISOString() ?? null,
      extendedBySec: r.rExtendedBySec,
    };
    actions.push(...diffProgramUpdate(stored, incoming, [recordingDiff]));
  }

  const shifted = await applyDiffActions(actions);
  return { shifted, touched: actions.length };
}

export const epgLiveService = {
  start,
  stop,
  pollOnce,
  isConnected,
};
