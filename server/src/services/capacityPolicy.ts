// Pure capacity-policy helpers. Extracted from capacityService so unit
// tests can run without a live Postgres — capacityService.ts imports
// db/client.ts which throws at import time when DATABASE_URL is unset.
//
// Nothing here touches IO: it's all plain arithmetic + env-variable
// parsing. The IO layer (statfs, unlink, drizzle) lives in
// capacityService.ts and covers these with the e2e suite.

const GIB = 1024 * 1024 * 1024;
const DEFAULT_THRESHOLD_GB = 10;

export interface SweepCandidate {
  id: string;
  sizeBytes: number;
  /**
   * Recording start timestamp. Null for scheduled/conflict rows that never
   * ran — those are filtered out anyway, but this keeps the type aligned
   * with the underlying `recordings.recordedAt` column (nullable).
   */
  recordedAt: Date | null;
  protectedFlag: boolean;
  state: string;
}

export interface DeletionPlan {
  ids: string[];
  plannedFreedBytes: number;
}

function envThresholdGb(): number | null {
  const raw = process.env.DISK_SWEEP_MIN_FREE_GB;
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Compute the sweep threshold in bytes:
 *   - DISK_SWEEP_MIN_FREE_GB env (if positive & finite) takes priority
 *   - otherwise 5% of totalBytes
 *   - otherwise 10 GiB fallback (statfs broken)
 */
export function thresholdBytes(totalBytes: number): number {
  const envGb = envThresholdGb();
  if (envGb != null) return Math.floor(envGb * GIB);
  if (totalBytes > 0) return Math.floor(totalBytes * 0.05);
  return DEFAULT_THRESHOLD_GB * GIB;
}

/**
 * Pick rows to delete, oldest-first, until simulated free-space exceeds
 * the threshold. Protected rows are excluded; rows with state not in
 * {'ready','failed'} are excluded (never yank bytes out from under an
 * in-progress recording/encode). Rows with non-positive size still get
 * picked (cheap to clear the DB row) but don't advance the simulated
 * freed counter.
 */
export function pickDeletionCandidates(
  rows: SweepCandidate[],
  freeBytes: number,
  threshold: number
): DeletionPlan {
  if (freeBytes >= threshold) {
    return { ids: [], plannedFreedBytes: 0 };
  }
  const eligible = rows
    .filter(
      (r) =>
        !r.protectedFlag &&
        (r.state === 'ready' || r.state === 'failed') &&
        r.recordedAt != null
    )
    .sort((a, b) => a.recordedAt!.getTime() - b.recordedAt!.getTime());

  let simulatedFree = freeBytes;
  const ids: string[] = [];
  let plannedFreed = 0;
  for (const row of eligible) {
    if (simulatedFree >= threshold) break;
    ids.push(row.id);
    const size = Math.max(0, row.sizeBytes);
    simulatedFree += size;
    plannedFreed += size;
  }
  return { ids, plannedFreedBytes: plannedFreed };
}
