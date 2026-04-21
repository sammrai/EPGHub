import { statfs, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { recordings } from '../db/schema.ts';
import {
  pickDeletionCandidates,
  thresholdBytes,
  type SweepCandidate,
  type DeletionPlan,
} from './capacityPolicy.ts';

// Disk capacity management.
//
// getDiskStatus() reports the filesystem containing RECORDING_DIR.
// sweep()        deletes oldest unprotected `recordings` rows in state
//                'ready' or 'failed' until free bytes exceed the
//                configured threshold.
//
// Pure helpers (thresholdBytes, pickDeletionCandidates) live in
// capacityPolicy.ts so they can be unit-tested without a live Postgres.

const DEFAULT_RECORDING_DIR = resolve('/workspaces/epghub/server/.recordings');
const GIB = 1024 * 1024 * 1024;
const DEFAULT_THRESHOLD_GB = 10;

export interface DiskStatus {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  threshold: number;
}

export interface SweepResult {
  deletedIds: string[];
  freedBytes: number;
}

// Re-export the pure helpers so callers don't need to care which module
// owns the implementation.
export { pickDeletionCandidates, thresholdBytes };
export type { SweepCandidate, DeletionPlan };

function recordingDir(): string {
  return process.env.RECORDING_DIR?.trim() || DEFAULT_RECORDING_DIR;
}

function envThresholdGb(): number | null {
  const raw = process.env.DISK_SWEEP_MIN_FREE_GB;
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Free-space reading. Returns null if statfs fails (obscure FS, EPERM, ...). */
async function readDisk(): Promise<{ totalBytes: number; freeBytes: number; usedBytes: number } | null> {
  const dir = recordingDir();
  try {
    const fs = await statfs(dir);
    const bsize = Number(fs.bsize);
    const blocks = Number(fs.blocks);
    const bfree = Number(fs.bfree);
    if (!Number.isFinite(bsize) || !Number.isFinite(blocks) || !Number.isFinite(bfree)) return null;
    const totalBytes = blocks * bsize;
    const freeBytes = bfree * bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return { totalBytes, freeBytes, usedBytes };
  } catch (err) {
    console.warn(
      `[capacity] statfs(${dir}) failed: ${(err as Error).message}`
    );
    return null;
  }
}

export async function getDiskStatus(): Promise<DiskStatus> {
  const reading = await readDisk();
  if (!reading) {
    // Fallback: if we can't read the fs just return zeros + the env threshold
    // (or the default) so callers get a consistent shape.
    const envGb = envThresholdGb() ?? DEFAULT_THRESHOLD_GB;
    return {
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      threshold: Math.floor(envGb * GIB),
    };
  }
  return {
    ...reading,
    threshold: thresholdBytes(reading.totalBytes),
  };
}

// -----------------------------------------------------------------
// Run the sweep end-to-end. Loops rather than plans+executes once so we
// can re-read free space (cheap) after unlinks — unlink() is eventually
// consistent on some filesystems and we'd rather over-sweep than leave
// a recording paused on disk-full.
// -----------------------------------------------------------------

async function unlinkIfExists(path: string | null | undefined): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return;
    console.warn(`[capacity] unlink ${path} failed: ${e.message}`);
  }
}

export interface SweepOptions {
  /**
   * Override the threshold (bytes) for this call. Bypasses env/filesystem
   * math — useful for admin "force sweep" and for tests that need to
   * drive the loop to exhaustion regardless of the container's actual
   * free space. When omitted the normal DISK_SWEEP_MIN_FREE_GB / 5%
   * logic applies.
   */
  minFreeBytes?: number;
}

export async function sweep(opts: SweepOptions = {}): Promise<SweepResult> {
  const status = await getDiskStatus();
  if (status.totalBytes === 0) {
    // statfs failed — we can't tell if we're low on space, so do nothing.
    return { deletedIds: [], freedBytes: 0 };
  }
  const threshold = opts.minFreeBytes != null && Number.isFinite(opts.minFreeBytes) && opts.minFreeBytes > 0
    ? opts.minFreeBytes
    : status.threshold;
  if (status.freeBytes >= threshold) {
    return { deletedIds: [], freedBytes: 0 };
  }

  // Candidate pool: ready/failed + unprotected, ordered oldest-first. We
  // bound the snapshot at 500 rows as a safety valve against runaway
  // deletes on a filesystem reporting nonsense numbers.
  const rows = await db
    .select({
      id: recordings.id,
      sizeBytes: recordings.size,
      recordedAt: recordings.recordedAt,
      protectedFlag: recordings.protected,
      state: recordings.state,
      filename: recordings.filename,
      rawFilename: recordings.rawFilename,
    })
    .from(recordings)
    .where(eq(recordings.protected, false))
    .orderBy(asc(recordings.recordedAt))
    .limit(500);

  const deletedIds: string[] = [];
  let freedBytes = 0;
  let currentFree = status.freeBytes;

  // Whitelist states that are safe to delete. `ready` = fully finalized;
  // `failed` = encode gave up, .ts is no longer needed. Skip scheduled/
  // recording/encoding/conflict rows — they either still have a live
  // pipeline (ffmpeg, recorder) or no file yet.
  const deletableStates = new Set(['ready', 'failed']);

  for (const row of rows) {
    if (currentFree >= threshold) break;
    if (!deletableStates.has(row.state)) continue;

    if (row.filename) await unlinkIfExists(row.filename);
    if (row.rawFilename && row.rawFilename !== row.filename) {
      await unlinkIfExists(row.rawFilename);
    }
    deletedIds.push(row.id);
    const sizeBytes = Math.max(0, Math.round(Number(row.sizeBytes ?? 0) * GIB));
    freedBytes += sizeBytes;
    currentFree += sizeBytes;
  }

  if (deletedIds.length > 0) {
    await db.delete(recordings).where(inArray(recordings.id, deletedIds));
    console.log(
      `[capacity] swept ${deletedIds.length} rows, freed ~${Math.round(freedBytes / GIB)} GiB`
    );
  }

  return { deletedIds, freedBytes };
}

export const capacityService = {
  getDiskStatus,
  sweep,
  thresholdBytes,
  pickDeletionCandidates,
};
