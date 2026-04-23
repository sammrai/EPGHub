import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  Recording,
  CreateRecording,
  UpdateRecording,
  RecordingState,
} from '../schemas/recording.ts';
import { scheduleService } from './scheduleService.ts';
import { channelService } from './channelService.ts';
import { tunerService } from './tunerService.ts';
import { allocate as allocateTuners } from './tunerAllocator.ts';
import { getRecDefaults } from './adminSettingsService.ts';
import { boss, QUEUE } from '../jobs/queue.ts';
import { db } from '../db/client.ts';
import { recordings, dropLogs } from '../db/schema.ts';
import type { DropSummary } from '../recording/dropChecker.ts';

// Unified recording service. Owns the single `recordings` table which spans
// the plan → recording → encode → terminal lifecycle in one row. Replaces
// the prior reserveService + recordedService split, which forced callers to
// cross-reference two state machines by heuristics to get the real outcome.

export class RecordingConflictError extends Error {
  constructor(
    public readonly reason: 'tuner-full' | 'duplicate' | 'program-missing',
    public readonly detail: Record<string, unknown> = {}
  ) {
    super(reason);
  }
}

export interface ListFilter {
  /** Narrow to a specific state or set of states. Omit to return everything. */
  state?: RecordingState | RecordingState[];
}

export interface RecordingService {
  list(filter?: ListFilter): Promise<Recording[]>;
  findById(id: string): Promise<Recording | null>;
  create(input: CreateRecording): Promise<Recording>;
  update(id: string, patch: UpdateRecording): Promise<Recording>;
  remove(id: string): Promise<boolean>;
  reallocateConflicts(): Promise<void>;
}

type RecordingRow = typeof recordings.$inferSelect;

// DB row → API DTO. Rehydrates `source` from the flat (sourceKind,
// sourceRuleId, sourceTvdbId) columns and coerces timestamps to ISO-8601.
// Drop summary is NOT populated here — the route handler attaches it when
// requested (/recordings/{id}/drops and list endpoints that opt in).
export function rowToRecording(row: RecordingRow): Recording {
  const source: Recording['source'] =
    row.sourceKind === 'rule'
      ? { kind: 'rule', ruleId: row.sourceRuleId ?? 0 }
      : row.sourceKind === 'series'
        ? { kind: 'series', tvdbId: row.sourceTvdbId ?? 0 }
        : { kind: 'once' };

  const out: Recording = {
    id: row.id,
    programId: row.programId,
    ch: row.ch,
    title: row.title,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    priority: row.priority as Recording['priority'],
    quality: row.quality as Recording['quality'],
    keepRaw: row.keepRaw,
    marginPre: row.marginPre,
    marginPost: row.marginPost,
    source,
    state: row.state as RecordingState,
  };

  if (row.allocatedTunerIdx != null) out.allocatedTunerIdx = row.allocatedTunerIdx;
  if (row.recordedAt != null) out.recordedAt = row.recordedAt.toISOString();
  if (row.filename != null) out.filename = row.filename;
  if (row.size != null) out.size = row.size;
  if (row.duration != null) out.duration = row.duration;
  if (row.encodeProgress != null) out.encodeProgress = row.encodeProgress;
  if (row.encodePreset != null) out.encodePreset = row.encodePreset;
  if (row.encodeError != null) out.encodeError = row.encodeError;
  if (row.thumb != null) out.thumb = row.thumb;
  if (row.thumbGenerated) out.thumbGenerated = row.thumbGenerated;
  if (row.protected) out.protected = row.protected;
  if (row.new) out.new = row.new;
  if (row.tvdbId != null) out.tvdbId = row.tvdbId;
  if (row.series != null) out.series = row.series;
  if (row.season != null) out.season = row.season;
  if (row.ep != null) out.ep = row.ep;
  if (row.epTitle != null) out.epTitle = row.epTitle;
  if (row.ruleMatched != null) out.ruleMatched = row.ruleMatched;
  if (row.originalStartAt != null) out.originalStartAt = row.originalStartAt.toISOString();
  if (row.originalEndAt != null) out.originalEndAt = row.originalEndAt.toISOString();
  if (row.extendedBySec !== 0) out.extendedBySec = row.extendedBySec;
  return out;
}

// --- Encode-lifecycle helpers (used by the encode worker) ---
// Kept at module level rather than on the interface so they don't leak into
// the public HTTP surface but still share the same drizzle client.

export async function setEncodeProgress(id: string, progress: number): Promise<void> {
  const clamped = Math.max(0, Math.min(1, progress));
  await db.update(recordings).set({ encodeProgress: clamped }).where(eq(recordings.id, id));
}

export async function setEncodeStarted(id: string, preset: string): Promise<void> {
  await db
    .update(recordings)
    .set({
      state: 'encoding',
      encodeStartedAt: new Date(),
      encodeEndedAt: null,
      encodeProgress: 0,
      encodePreset: preset,
      encodeError: null,
    })
    .where(eq(recordings.id, id));
}

export async function setEncodeFinal(args: {
  id: string;
  filename: string;
  endedAt: Date;
  preset: string;
}): Promise<void> {
  await db
    .update(recordings)
    .set({
      filename: args.filename,
      state: 'ready',
      encodeProgress: 1,
      encodeEndedAt: args.endedAt,
      encodePreset: args.preset,
      encodeError: null,
    })
    .where(eq(recordings.id, args.id));
}

export async function setEncodeFailed(id: string, error: string): Promise<void> {
  await db
    .update(recordings)
    .set({
      state: 'failed',
      encodeEndedAt: new Date(),
      encodeError: error.slice(0, 2000),
    })
    .where(eq(recordings.id, id));
}

// --- Drop-log persistence. Called from recorder.stop() once the .ts rename
// succeeded. FK (drop_logs.recording_id → recordings.id) is guaranteed by
// then. Upsert — a re-run overwrites in place.
export interface DropLogRow {
  recordingId: string;
  errorCnt: number;
  dropCnt: number;
  scramblingCnt: number;
  perPid: Record<string, { err: number; drop: number; scr: number }>;
  createdAt: string;
}

export async function saveDropLog(recordingId: string, summary: DropSummary): Promise<void> {
  await db
    .insert(dropLogs)
    .values({
      recordingId,
      errorCnt: summary.errorCnt,
      dropCnt: summary.dropCnt,
      scramblingCnt: summary.scramblingCnt,
      perPid: summary.perPid,
    })
    .onConflictDoUpdate({
      target: dropLogs.recordingId,
      set: {
        errorCnt: summary.errorCnt,
        dropCnt: summary.dropCnt,
        scramblingCnt: summary.scramblingCnt,
        perPid: summary.perPid,
      },
    });
}

export async function getDropLog(recordingId: string): Promise<DropLogRow | null> {
  const [row] = await db
    .select()
    .from(dropLogs)
    .where(eq(dropLogs.recordingId, recordingId))
    .limit(1);
  if (!row) return null;
  return {
    recordingId: row.recordingId,
    errorCnt: row.errorCnt,
    dropCnt: row.dropCnt,
    scramblingCnt: row.scramblingCnt,
    perPid: row.perPid ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

// Swallow ENOENT (file already gone — user removed out-of-band, or a prior
// delete attempt partially succeeded). Propagate any other filesystem error.
async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return;
    throw err;
  }
}

class DrizzleRecordingService implements RecordingService {
  async list(filter: ListFilter = {}): Promise<Recording[]> {
    const states = filter.state == null
      ? null
      : Array.isArray(filter.state)
        ? filter.state
        : [filter.state];
    const rows = states && states.length > 0
      ? await db
          .select()
          .from(recordings)
          .where(inArray(recordings.state, states))
          .orderBy(asc(recordings.startAt))
      : await db.select().from(recordings).orderBy(asc(recordings.startAt));
    return rows.map(rowToRecording);
  }

  async findById(id: string): Promise<Recording | null> {
    const [row] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
    return row ? rowToRecording(row) : null;
  }

  async create(input: CreateRecording): Promise<Recording> {
    const program = await scheduleService.findById(input.programId);
    if (!program) {
      throw new RecordingConflictError('program-missing', { programId: input.programId });
    }

    // Merge with admin-configured defaults for every attribute the caller
    // omitted. The zod schema used to carry `.default(...)` for these, but
    // admins now override them from the Settings page via admin_settings.
    const defaults = await getRecDefaults();
    const priority   = input.priority   ?? defaults.priority;
    const quality    = input.quality    ?? defaults.quality;
    const keepRaw    = input.keepRaw    ?? defaults.keepRaw;
    const marginPre  = input.marginPre  ?? defaults.marginPre;
    const marginPost = input.marginPost ?? defaults.marginPost;

    // Full list — we need both scheduled and non-terminal rows to detect
    // duplicates and feed the allocator.
    const existing = await this.list();

    // Duplicate: same program already has a recording row (any state except
    // terminal failure is a collision). We treat everything except 'failed'
    // as live so a user can't silently double-book.
    const duplicate = existing.find(
      (r) => r.programId === program.id && r.state !== 'failed'
    );
    if (duplicate && !input.force) {
      throw new RecordingConflictError('duplicate', { existingRecordingId: duplicate.id });
    }

    const id = `rec_${randomUUID()}`;
    const source = input.source;
    const sourceRuleId = source.kind === 'rule' ? source.ruleId : null;
    const sourceTvdbId = source.kind === 'series' ? source.tvdbId : null;

    // Priority allocator: build the "as-if-we-inserted" candidate set, pass
    // it + the raw Mirakurun tuner list to tunerAllocator.allocate(). If the
    // candidate lands in `preempted`, every compatible slot is already
    // held by a higher-priority recording — reject with 409 tuner-full
    // (unless force). If the candidate is allocated but existing
    // lower-priority rows got preempted as a side effect, demote them to
    // state='conflict'. Only rows in states that need tuner slots
    // (scheduled/recording/conflict) participate — terminal rows are
    // excluded.
    const [channels, devices] = await Promise.all([channelService.list(), tunerService.devices()]);
    const candidate: Recording = {
      id,
      programId: program.id,
      ch: program.ch,
      startAt: program.startAt,
      endAt: program.endAt,
      title: program.title,
      priority,
      quality,
      keepRaw,
      marginPre,
      marginPost,
      source,
      state: 'scheduled',
    };
    // Pool includes rows that actively compete for tuners. Exclude the
    // duplicate (we replace it), 'conflict' ghosts (they already lost),
    // and terminal states.
    const pool = existing.filter(
      (r) =>
        r.id !== duplicate?.id &&
        r.state !== 'conflict' &&
        r.state !== 'failed' &&
        r.state !== 'ready' &&
        r.state !== 'encoding'
    );
    const alloc = allocateTuners([...pool, candidate], devices, { channels });
    const candidatePreempted = alloc.preempted.includes(id);
    if (candidatePreempted && !input.force) {
      throw new RecordingConflictError('tuner-full', { preempted: alloc.preempted.length });
    }

    // Demote preempted existing rows to 'conflict'. Iterate to fixed-point
    // — demoting one row can shift another out of its slot. Bound at 10
    // iterations against pathological cases.
    const demotedIds = new Set<string>(alloc.preempted.filter((pid) => pid !== id));
    let survivors = [...pool, candidate].filter((r) => !demotedIds.has(r.id));
    for (let i = 0; i < 10; i++) {
      const pass = allocateTuners(survivors, devices, { channels });
      const newlyPreempted = pass.preempted.filter((pid) => pid !== id && !demotedIds.has(pid));
      if (newlyPreempted.length === 0) break;
      for (const pid of newlyPreempted) demotedIds.add(pid);
      survivors = survivors.filter((r) => !demotedIds.has(r.id));
    }

    if (duplicate) {
      await db.delete(recordings).where(eq(recordings.id, duplicate.id));
    }

    const allocatedTunerIdx = alloc.allocated.get(id);
    const [inserted] = await db
      .insert(recordings)
      .values({
        id,
        programId: program.id,
        ch: program.ch,
        startAt: new Date(program.startAt),
        endAt: new Date(program.endAt),
        title: program.title,
        priority,
        quality,
        keepRaw,
        marginPre,
        marginPost,
        sourceKind: source.kind,
        sourceRuleId,
        sourceTvdbId,
        state: candidatePreempted ? 'conflict' : 'scheduled',
        allocatedTunerIdx: allocatedTunerIdx ?? null,
      })
      .returning();

    for (const did of demotedIds) {
      await db
        .update(recordings)
        .set({ state: 'conflict', allocatedTunerIdx: null })
        .where(eq(recordings.id, did));
    }

    const recording = rowToRecording(inserted);

    // Enqueue RECORD_START / RECORD_STOP unless the row landed in conflict
    // — there's no tuner for it to use, so the start job would just race
    // with whichever recording *did* get the slot.
    if (recording.state !== 'conflict') {
      try {
        const startAt = new Date(Date.parse(recording.startAt) - recording.marginPre * 1000);
        const endAt = new Date(Date.parse(recording.endAt) + recording.marginPost * 1000);
        await boss.send(QUEUE.RECORD_START, { recordingId: recording.id }, { startAfter: startAt });
        await boss.send(QUEUE.RECORD_STOP, { recordingId: recording.id }, { startAfter: endAt });
      } catch (err) {
        console.warn('[recording] failed to enqueue record jobs:', (err as Error).message);
      }
    }
    return recording;
  }

  async update(id: string, patch: UpdateRecording): Promise<Recording> {
    // Caller gates on state=scheduled; here we just apply the partial patch.
    const set: Record<string, unknown> = {};
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.quality !== undefined) set.quality = patch.quality;
    if (patch.keepRaw !== undefined) set.keepRaw = patch.keepRaw;
    if (patch.marginPre !== undefined) set.marginPre = patch.marginPre;
    if (patch.marginPost !== undefined) set.marginPost = patch.marginPost;

    if (Object.keys(set).length > 0) {
      await db.update(recordings).set(set).where(eq(recordings.id, id));
    }

    // Margins control when pg-boss fires RECORD_START / RECORD_STOP. If
    // they shifted, cancel existing jobs and re-queue at the new times.
    if (patch.marginPre !== undefined || patch.marginPost !== undefined) {
      const row = await this.findById(id);
      if (row && row.state === 'scheduled') {
        try {
          const rows = await db.execute<{ id: string; name: string }>(
            sql`select id, name from pgboss.job
                  where name in (${QUEUE.RECORD_START}, ${QUEUE.RECORD_STOP})
                    and state in ('created','retry')
                    and data->>'recordingId' = ${id}`
          );
          for (const r of rows) {
            await boss.cancel(r.name, r.id).catch(() => undefined);
          }
          const startAt = new Date(Date.parse(row.startAt) - row.marginPre * 1000);
          const endAt = new Date(Date.parse(row.endAt) + row.marginPost * 1000);
          await boss.send(QUEUE.RECORD_START, { recordingId: id }, { startAfter: startAt });
          await boss.send(QUEUE.RECORD_STOP, { recordingId: id }, { startAfter: endAt });
        } catch (err) {
          console.warn('[recording] update re-queue failed (non-fatal):', err);
        }
      }
    }

    const updated = await this.findById(id);
    if (!updated) throw new Error(`recording ${id} vanished after update`);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    // Fetch first so we still have filename paths after the row is gone.
    // Missing row → 404 at the caller.
    const existing = await this.findById(id);
    if (!existing) return false;

    const state = existing.state;

    // Live pipe? Abort it so we don't keep writing to a .part file with no
    // backing DB row. stopRecording() isn't safe here — it tries to finalize
    // into a ready/encoding state, which we don't want on a cancel.
    if (state === 'recording') {
      try {
        const { abortRecording } = await import('../recording/recorder.ts');
        await abortRecording(id);
      } catch (err) {
        console.warn('[recording] abortRecording failed (continuing with delete):', err);
      }
    }

    // Cancel pending RECORD_START / RECORD_STOP jobs so they don't re-open
    // the stream after we delete. Safe to call even if no jobs exist.
    if (state === 'scheduled' || state === 'recording' || state === 'conflict') {
      try {
        const rows = await db.execute<{ id: string; name: string }>(
          sql`select id, name from pgboss.job
                where name in (${QUEUE.RECORD_START}, ${QUEUE.RECORD_STOP})
                  and state in ('created','retry')
                  and data->>'recordingId' = ${id}`
        );
        for (const r of rows) {
          await boss.cancel(r.name, r.id).catch(() => undefined);
        }
      } catch (err) {
        console.warn('[recording] pg-boss cancel failed (continuing):', err);
      }
    }

    // On-disk files live on the row. Clean them up for ready/failed rows
    // (produced a real file) — scheduled/conflict rows never wrote anything.
    if (state === 'ready' || state === 'failed' || state === 'encoding') {
      if (existing.filename) {
        await unlinkIfExists(existing.filename);
        await unlinkIfExists(existing.filename + '.part');
      }
    }

    const deleted = await db.delete(recordings).where(eq(recordings.id, id)).returning({ id: recordings.id });
    if (deleted.length === 0) return false;

    // Freeing a tuner slot may let a previously-conflicting row run now.
    try {
      await this.reallocateConflicts();
    } catch (err) {
      console.warn('[recording] reallocateConflicts failed (non-fatal):', err);
    }
    return true;
  }

  /**
   * Re-run the tuner allocator over scheduled + conflict rows. Rows that
   * newly land in an allocated slot are promoted (state='scheduled',
   * allocatedTunerIdx written, pg-boss jobs enqueued). Rows that lose
   * their slot are demoted (state='conflict', allocatedTunerIdx=null).
   * Same contract as the prior reserveService helper.
   */
  async reallocateConflicts(): Promise<void> {
    // Only scheduled + conflict rows compete for tuner slots. Terminal
    // states (ready/failed) never did; recording rows already own their
    // slot and the allocator shouldn't yank it out mid-flight.
    const current = await this.list({ state: ['scheduled', 'conflict'] });
    if (current.length === 0) return;
    const [channels, devices] = await Promise.all([channelService.list(), tunerService.devices()]);

    const alloc = allocateTuners(current, devices, { channels });
    const preempted = new Set(alloc.preempted);

    for (const r of current) {
      const newIdx = alloc.allocated.get(r.id);
      const nowPreempted = preempted.has(r.id);

      if (r.state === 'conflict' && !nowPreempted && newIdx != null) {
        await db
          .update(recordings)
          .set({ state: 'scheduled', allocatedTunerIdx: newIdx })
          .where(eq(recordings.id, r.id));
        try {
          const startAt = new Date(Date.parse(r.startAt) - r.marginPre * 1000);
          const endAt = new Date(Date.parse(r.endAt) + r.marginPost * 1000);
          await boss.send(QUEUE.RECORD_START, { recordingId: r.id }, { startAfter: startAt });
          await boss.send(QUEUE.RECORD_STOP, { recordingId: r.id }, { startAfter: endAt });
        } catch (err) {
          console.warn('[recording] failed to enqueue promoted record jobs:', (err as Error).message);
        }
      } else if (r.state === 'scheduled' && nowPreempted) {
        await db
          .update(recordings)
          .set({ state: 'conflict', allocatedTunerIdx: null })
          .where(eq(recordings.id, r.id));
      } else if (r.state === 'scheduled' && newIdx != null && r.allocatedTunerIdx !== newIdx) {
        await db
          .update(recordings)
          .set({ allocatedTunerIdx: newIdx })
          .where(eq(recordings.id, r.id));
      }
    }
  }
}

export const recordingService: RecordingService = new DrizzleRecordingService();
