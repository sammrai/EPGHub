// Pure-function half of epgLiveService. Pulled out so the unit tests can
// import it without dragging in the DB client, pg-boss, or the Mirakurun
// runtime wiring. See epgLiveService.ts for the runtime side.

/** A program as persisted in the DB — only the fields the differ touches. */
export interface StoredProgram {
  id: string;
  startAt: string; // ISO
  endAt: string;   // ISO
}

/** The updated program payload we just observed (from SSE or a re-fetch). */
export interface IncomingProgram {
  id: string;
  startAt: string;
  endAt: string;
}

/** A recording row as consumed by the differ. */
export interface RecordingForDiff {
  id: string;
  programId: string;
  startAt: string;
  endAt: string;
  state: string;
  marginPost: number;
  originalStartAt: string | null;
  originalEndAt: string | null;
  extendedBySec: number;
}

// Back-compat alias so tests that still reference the old name keep working.
export type ReserveForDiff = RecordingForDiff;

/** Action emitted by the pure differ; the runtime side executes these. */
export type DiffAction =
  | {
      type: 'updateEnd';
      recordingId: string;
      programId: string;
      /** Previous recording.endAt — for the extendedBySec delta. */
      prevEndAt: string;
      newEndAt: string;
      /** True when we should lock in originalStartAt/endAt (first shift). */
      captureOriginal: boolean;
      /** Recording's current state — recorder uses this to decide live vs scheduled. */
      state: string;
    }
  | {
      type: 'bumpProgramRevision';
      programId: string;
      newStartAt: string;
      newEndAt: string;
    };

// Minimum shift we act on. Mirakurun sometimes re-emits unchanged programs;
// ignoring sub-second drift keeps the pg-boss queue from churning.
export const SHIFT_THRESHOLD_MS = 1000;

/**
 * Pure differ. Given a program's old + new end time and the recordings that
 * reference it, produce the minimal action list. Exported so it can be
 * unit-tested in isolation — the caller is responsible for DB side-effects.
 *
 * Contract:
 *   - Always emits a bumpProgramRevision action when newEndAt != oldEndAt
 *     (regardless of threshold, since the program row itself must stay in
 *     sync with what Mirakurun said).
 *   - Emits an updateEnd action per recording in state 'scheduled' or
 *     'recording' whose programId matches AND whose diff exceeds
 *     SHIFT_THRESHOLD_MS.
 *   - Recordings in terminal states (ready / failed / encoding) and
 *     'conflict' are ignored.
 */
export function diffProgramUpdate(
  oldProgram: StoredProgram,
  newProgram: IncomingProgram,
  recordingsList: RecordingForDiff[]
): DiffAction[] {
  if (oldProgram.id !== newProgram.id) return [];
  const actions: DiffAction[] = [];
  const oldEndMs = Date.parse(oldProgram.endAt);
  const newEndMs = Date.parse(newProgram.endAt);
  const hasEndShift = Number.isFinite(oldEndMs)
    && Number.isFinite(newEndMs)
    && oldEndMs !== newEndMs;

  if (hasEndShift) {
    actions.push({
      type: 'bumpProgramRevision',
      programId: newProgram.id,
      newStartAt: newProgram.startAt,
      newEndAt: newProgram.endAt,
    });
  }

  if (!hasEndShift || Math.abs(newEndMs - oldEndMs) < SHIFT_THRESHOLD_MS) {
    return actions;
  }

  for (const r of recordingsList) {
    if (r.programId !== newProgram.id) continue;
    if (r.state !== 'scheduled' && r.state !== 'recording') continue;
    const recordingEndMs = Date.parse(r.endAt);
    if (!Number.isFinite(recordingEndMs)) continue;
    if (recordingEndMs === newEndMs) continue;
    actions.push({
      type: 'updateEnd',
      recordingId: r.id,
      programId: r.programId,
      prevEndAt: r.endAt,
      newEndAt: newProgram.endAt,
      captureOriginal: r.originalEndAt == null,
      state: r.state,
    });
  }

  return actions;
}
