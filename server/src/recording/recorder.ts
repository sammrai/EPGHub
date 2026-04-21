import { createWriteStream } from 'node:fs';
import { mkdir, stat, rename, unlink, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { Writable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { recordings, programs, tvdbEntries, channels } from '../db/schema.ts';
import { boss, QUEUE } from '../jobs/queue.ts';
import { recordedHistoryService } from '../services/recordedHistoryService.ts';
import { normalizeTitle } from '../services/ruleExpander.ts';
import { DropChecker, type DropSummary } from './dropChecker.ts';
import { saveDropLog } from '../services/recordingService.ts';
import { plexPath, type PlexNameInput } from './plexNaming.ts';

// -----------------------------------------------------------------
// Recording orchestrator. Holds the active pipes so handleRecordStart /
// handleRecordStop (both triggered via pg-boss at marginPre/marginPost
// offsets) can coordinate across job firings.
//
// Intentionally process-local: restarting the server kills active
// recordings. Persisting stream-handles across restarts would require
// resuming a mid-TS file which Mirakurun doesn't support cleanly.
//
// After the R0 refactor there's a single `recordings` row per job. The
// recorder UPDATEs the row in place through the state machine
// scheduled → recording → encoding|ready → (ffmpeg) → ready|failed
// rather than INSERTing a new `recorded` row on stop.
// -----------------------------------------------------------------

interface ActiveRec {
  recordingId: string;
  /** Current live fetch controller. Replaced during retry. */
  abortCtrl: AbortController;
  filePath: string;
  tmpPath: string;
  writer: Writable;
  startedAt: Date;
  /** Resolves when the stream has been fully piped (stop or natural EOF). */
  done: Promise<void>;
  /** Per-recording drop detector. Feed every chunk before the file write. */
  dropChecker: DropChecker;
  /** True once stop() fired — used so the retry wrapper stops retrying. */
  stopped: boolean;
}

// Phase 3: how soon after start() we still treat a stream error as
// "transient, worth one retry". Anything beyond this window almost
// certainly means the tuner held the connection for real content then
// died, and re-fetching would truncate the file anyway — safer to fail
// and let the operator intervene.
const RETRY_WINDOW_MS = 5_000;
const MAX_RETRIES = 1;

const active = new Map<string, ActiveRec>();

function recordingDir(): string {
  return process.env.RECORDING_DIR ?? resolve('/workspaces/epghub/server/.recordings');
}

function mirakurunBase(): string | null {
  const url = process.env.MIRAKURUN_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

// Mirakurun service id is the numeric suffix after `svc-` in our channel id
// (e.g. `svc-400151` → `400151`). Falls back to null for fixture channels
// that don't map to a real tuner.
function serviceIdFromCh(ch: string): number | null {
  const m = ch.match(/^svc-(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the live stream URL for a channel. Priority:
 *   1. channels.streamUrl — populated by channelSyncService for m3u + mirakurun.
 *   2. Legacy derivation: MIRAKURUN_URL + `/api/services/${sid}/stream` when
 *      the channel id matches the `svc-<n>` convention.
 * Returns null when neither path produces a URL.
 */
async function resolveStreamUrl(ch: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ streamUrl: channels.streamUrl })
      .from(channels)
      .where(eq(channels.id, ch))
      .limit(1);
    if (row?.streamUrl) return row.streamUrl;
  } catch (err) {
    console.warn(`[rec] channels lookup for ${ch} failed, falling back:`, err);
  }
  const base = mirakurunBase();
  const sid = serviceIdFromCh(ch);
  if (base && sid != null) return `${base}/api/services/${sid}/stream`;
  return null;
}

function sanitizeTitle(t: string): string {
  return t
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

function jstStamp(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}${mm}${dd}_${hh}${mi}`;
}

export async function startRecording(recordingId: string): Promise<void> {
  if (active.has(recordingId)) {
    console.log(`[rec] ${recordingId} already active, skipping`);
    return;
  }
  const [row] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
  if (!row) {
    console.warn(`[rec] ${recordingId}: recording not found`);
    return;
  }
  if (row.state === 'ready' || row.state === 'failed') {
    console.log(`[rec] ${recordingId}: already ${row.state}`);
    return;
  }

  // Resolve the upstream stream URL. Prefer the channel row's streamUrl
  // (populated by channelSyncService for both m3u and mirakurun sources);
  // fall back to legacy `${MIRAKURUN_URL}/api/services/${sid}/stream`
  // derivation for existing rows that haven't been re-synced yet.
  const streamUrl = await resolveStreamUrl(row.ch);
  if (!streamUrl) {
    console.warn(`[rec] ${recordingId}: no stream URL for ch=${row.ch}`);
    await db
      .update(recordings)
      .set({ state: 'failed', encodeError: 'no stream URL for channel', encodeEndedAt: new Date() })
      .where(eq(recordings.id, recordingId));
    return;
  }

  const dir = recordingDir();
  await mkdir(dir, { recursive: true });
  const filename = `${jstStamp(row.startAt.toISOString())}_${row.ch}_${sanitizeTitle(row.title)}_${recordingId.slice(-8)}.ts`;
  const filePath = join(dir, filename);
  const tmpPath = `${filePath}.part`;

  const ctrl = new AbortController();
  const startedAt = new Date();
  const dropChecker = new DropChecker();

  const rec: ActiveRec = {
    recordingId,
    abortCtrl: ctrl,
    filePath,
    tmpPath,
    writer: null as unknown as Writable, // writer is internal to pipe helper
    startedAt,
    // `done` is filled in below once we've kicked off the retrying pipe.
    done: Promise.resolve(),
    dropChecker,
    stopped: false,
  };
  active.set(recordingId, rec);

  const done = pipeWithRetry({
    url: streamUrl,
    destPath: tmpPath,
    recordingId,
    rec,
    startedAt,
  });
  rec.done = done;

  await db
    .update(recordings)
    .set({ state: 'recording', recordedAt: startedAt })
    .where(eq(recordings.id, recordingId));

  console.log(`[rec] started ${recordingId} → ${filename}`);

  // Don't await — the fetch continues until stop() aborts it. Attach a
  // failure handler so unexpected stream errors (after retry budget
  // exhausted) mark the recording as failed.
  done.catch(async (err) => {
    if (rec.stopped) return; // expected when stop() fires
    console.error(`[rec] ${recordingId} stream error (retries exhausted):`, err);
    active.delete(recordingId);
    await db
      .update(recordings)
      .set({
        state: 'failed',
        encodeError: (err as Error)?.message?.slice(0, 2000) ?? 'stream error',
        encodeEndedAt: new Date(),
      })
      .where(eq(recordings.id, recordingId))
      .catch(() => {});
    await unlink(tmpPath).catch(() => {});
  });
}

/**
 * Resolve filesystem path collisions by appending `_1`, `_2`, ... before the
 * extension. Returns the original path if it's free. Logs a warning the first
 * time it skips a slot so operators can spot duplicate-airing misconfigurations.
 *
 * Exported for encoder reuse — stopRecording() and the encoder worker both
 * land files under the Plex tree and need the same dedupe policy.
 */
export async function resolveCollision(path: string, recordingId: string): Promise<string> {
  try {
    await access(path);
  } catch {
    return path; // path is free
  }
  // Split `/dir/base.ext` → `/dir/base` + `.ext`. If no extension, the
  // suffix goes at the very end.
  const m = path.match(/^(.*)(\.[^./]+)$/);
  const prefix = m ? m[1] : path;
  const ext = m ? m[2] : '';
  console.warn(`[rec] ${recordingId} path collision at ${path}; finding free slot`);
  for (let i = 1; i < 100; i++) {
    const candidate = `${prefix}_${i}${ext}`;
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  // Last resort — append the recording id if 99 slots are all taken.
  return `${prefix}_${recordingId.slice(-8)}${ext}`;
}

export async function stopRecording(recordingId: string): Promise<void> {
  const rec = active.get(recordingId);
  if (!rec) {
    console.log(`[rec] ${recordingId}: no active recording to stop`);
    return;
  }
  rec.stopped = true;
  rec.abortCtrl.abort();
  try {
    await rec.done;
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name !== 'AbortError') {
      console.warn(`[rec] ${recordingId} flush error:`, err);
    }
  }
  active.delete(recordingId);

  // Look up the recording row + matched TVDB entry (if any) so we can
  // build a Plex-aware destination path. Falls back to the flat layout
  // if the row can't be read — better to land on disk than lose bytes.
  const [row] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
  if (!row) {
    await unlink(rec.tmpPath).catch(() => undefined);
    return;
  }
  // Pull the program for tvdb/series/ep so the recording row carries
  // enough context for the UI without an extra join.
  const [prog] = await db.select().from(programs).where(eq(programs.id, row.programId)).limit(1);
  const series = prog?.series ?? null;

  let tvdbPoster = '';
  let tvdbEntry: { kind: 'series' | 'movie'; title: string; year: number | null } | null = null;
  if (prog?.tvdbId != null) {
    const [t] = await db
      .select({
        poster: tvdbEntries.poster,
        kind: tvdbEntries.kind,
        title: tvdbEntries.title,
        year: tvdbEntries.year,
      })
      .from(tvdbEntries)
      .where(eq(tvdbEntries.tvdbId, prog.tvdbId))
      .limit(1);
    tvdbPoster = t?.poster ?? '';
    if (t && (t.kind === 'series' || t.kind === 'movie')) {
      tvdbEntry = { kind: t.kind, title: t.title, year: t.year };
    }
  }

  // Build the Plex-style destination. dir/filename are relative to
  // RECORDING_DIR; we mkdir recursively and then collision-loop until we
  // find an unused path.
  const plexInput: PlexNameInput = {
    title: row.title,
    startAtIso: row.startAt.toISOString(),
    tvdb: tvdbEntry,
    season: prog?.tvdbSeason ?? null,
    episode: prog?.tvdbEpisode ?? null,
    episodeName: prog?.tvdbEpisodeName ?? null,
    extension: 'ts',
    recordingId,
  };
  const plex = plexPath(plexInput);
  const baseDir = recordingDir();
  const plexDir = join(baseDir, plex.dir);
  await mkdir(plexDir, { recursive: true }).catch(() => undefined);
  const finalPath = await resolveCollision(join(plexDir, plex.filename), recordingId);

  // Move .part → Plex path so readers/encoders never see a partial file.
  let renamed = false;
  try {
    await rename(rec.tmpPath, finalPath);
    renamed = true;
    rec.filePath = finalPath; // update so downstream logs/logic use the new path
  } catch (err) {
    console.error(`[rec] ${recordingId} rename failed:`, err);
    await db
      .update(recordings)
      .set({
        state: 'failed',
        encodeError: (err as Error)?.message?.slice(0, 2000) ?? 'rename failed',
        encodeEndedAt: new Date(),
      })
      .where(eq(recordings.id, recordingId))
      .catch(() => {});
    await unlink(rec.tmpPath).catch((unlinkErr) => {
      console.warn(`[rec] ${recordingId} failed to cleanup .part after rename failure:`, unlinkErr);
    });
    return;
  }

  try {
    const stats = await stat(rec.filePath).catch(() => null);
    const sizeBytes = stats?.size ?? 0;
    const sizeGb = Number((sizeBytes / 1024 ** 3).toFixed(3));
    const durationMin = Math.max(
      1,
      Math.round((Date.now() - rec.startedAt.getTime()) / 60_000)
    );

    // UPDATE in place — no more INSERT into a separate recorded table.
    // `keepRaw=true` lands directly in 'ready'; otherwise we enter
    // 'encoding' until the encode worker finishes. Filename/rawFilename
    // both point at the raw .ts for now; encoder overwrites filename
    // with the encoded path on success but keeps rawFilename pinned.
    const finalState = row.keepRaw ? 'ready' : 'encoding';
    await db
      .update(recordings)
      .set({
        state: finalState,
        filename: rec.filePath,
        rawFilename: rec.filePath,
        size: sizeGb,
        duration: durationMin,
        thumb: tvdbPoster,
        tvdbId: prog?.tvdbId ?? null,
        series,
        season: prog?.tvdbSeason ?? null,
        ep: prog?.tvdbEpisode ?? null,
        epTitle: prog?.tvdbEpisodeName ?? null,
        new: true,
      })
      .where(eq(recordings.id, recordingId));

    // Persist drop summary once the row's filename is on disk so the FK to
    // recordings.id is satisfied. Swallow errors — a drop-log write failure
    // shouldn't mask a successful recording.
    try {
      const summary: DropSummary = rec.dropChecker.summary();
      await saveDropLog(recordingId, summary);
      if (summary.dropCnt > 0 || summary.errorCnt > 0 || summary.scramblingCnt > 0) {
        console.log(
          `[rec] ${recordingId} drop summary: err=${summary.errorCnt} drop=${summary.dropCnt} scr=${summary.scramblingCnt}`
        );
      }
    } catch (err) {
      console.warn(`[rec] ${recordingId}: failed to save drop log:`, err);
    }

    // Append a recorded-history row so the rule expander can skip this
    // episode on future passes, even if the recordings row is later
    // deleted. Same key shape as ruleExpander.matches().
    try {
      const hasTvdbTuple =
        prog?.tvdbId != null && prog.tvdbSeason != null && prog.tvdbEpisode != null;
      await recordedHistoryService.insert({
        tvdbId: prog?.tvdbId ?? null,
        season: prog?.tvdbSeason ?? null,
        episode: prog?.tvdbEpisode ?? null,
        normalizedTitle: hasTvdbTuple ? null : normalizeTitle(row.title),
        endAt: row.endAt,
      });
    } catch (err) {
      console.warn(`[rec] ${recordingId}: failed to insert recorded-history:`, err);
    }

    // Queue encode if the user didn't opt to keep the raw TS.
    if (!row.keepRaw) {
      try {
        await boss.send(QUEUE.ENCODE, { recordingId });
      } catch (err) {
        console.warn(`[rec] ${recordingId}: failed to enqueue encode:`, err);
      }
    }
    console.log(`[rec] stopped ${recordingId} → ${rec.filePath} (${sizeGb} GB, ${durationMin} min)`);
  } catch (err) {
    // Finalize-flow failure. Normally rename has already succeeded so
    // tmpPath is gone — the unlink is harmless. The guard is here so any
    // future refactor that can throw *before* the rename succeeds still
    // cleans up the .part file instead of leaving it orphaned.
    if (!renamed) {
      await unlink(rec.tmpPath).catch((unlinkErr) => {
        console.warn(`[rec] ${recordingId} failed to cleanup .part after finalize error:`, unlinkErr);
      });
    }
    throw err;
  }
}

export function activeRecordings(): Array<{
  recordingId: string;
  startedAt: string;
  filePath: string;
}> {
  return Array.from(active.values()).map((r) => ({
    recordingId: r.recordingId,
    startedAt: r.startedAt.toISOString(),
    filePath: r.filePath,
  }));
}

export async function stopAllRecordings(): Promise<void> {
  const ids = Array.from(active.keys());
  await Promise.all(
    ids.map((id) =>
      stopRecording(id).catch((err) => {
        console.warn(`[rec] shutdown-stop ${id} failed:`, err);
      })
    )
  );
}

export function isActive(recordingId: string): boolean {
  return active.has(recordingId);
}

/**
 * Abort an active recording WITHOUT committing a terminal state — used by
 * recordingService.remove() when the user cancels a live row. Any `.part`
 * file is deleted. Safe to call on an unknown id.
 *
 * stopRecording() is the normal completion path (drives the row to
 * ready/encoding); abortRecording() is the destructive cancel path.
 */
export async function abortRecording(recordingId: string): Promise<void> {
  const rec = active.get(recordingId);
  if (!rec) return;
  rec.abortCtrl.abort();
  try {
    await rec.done;
  } catch {
    // AbortError + any fetch error are expected here; ignore.
  }
  active.delete(recordingId);
  await unlink(rec.tmpPath).catch(() => undefined);
  console.log(`[rec] aborted ${recordingId} (recording deleted)`);
}

// -----------------------------------------------------------------
// Program-extension rescheduling. Called by epgLiveService when
// Mirakurun EIT[p/f] says a program's endAt has shifted. The Mirakurun
// service stream doesn't terminate on program boundary, so the live
// fetch → file pipe keeps reading: all we need is to replace the
// pending RECORD_STOP pg-boss job with one at the new end time.
//
// `newEndIso` is the new program.endAt (without marginPost — we add it).
// -----------------------------------------------------------------
export async function rescheduleStop(recordingId: string, newEndIso: string): Promise<void> {
  const [row] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
  if (!row) return;
  const marginPost = row.marginPost ?? 0;
  const newStopAt = new Date(Date.parse(newEndIso) + marginPost * 1000);

  try {
    const rows = await db.execute<{ id: string }>(
      sql`select id from pgboss.job
            where name = ${QUEUE.RECORD_STOP}
              and state in ('created','retry')
              and data->>'recordingId' = ${recordingId}`
    );
    for (const r of rows) {
      await boss.cancel(QUEUE.RECORD_STOP, r.id).catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[rec] rescheduleStop(${recordingId}): cancel lookup failed`, err);
  }

  try {
    await boss.send(QUEUE.RECORD_STOP, { recordingId }, { startAfter: newStopAt });
  } catch (err) {
    console.warn(`[rec] rescheduleStop(${recordingId}): re-send failed`, err);
    return;
  }

  if (active.has(recordingId)) {
    console.log(`[rec] ${recordingId} extended → stop at ${newStopAt.toISOString()} (live)`);
  } else {
    console.log(`[rec] ${recordingId} extended → stop at ${newStopAt.toISOString()} (scheduled)`);
  }
}

// -----------------------------------------------------------------
// Fetch → file pipe. Uses fetch() with an AbortSignal so stopRecording()
// can cleanly close the TCP connection. Node 18+ fetch body is a
// ReadableStream<Uint8Array>; we drain it chunk by chunk into a writable
// file stream.
//
// Each chunk is fed to the caller's DropChecker *before* the file write
// so the summary never misses tail bytes under writer backpressure.
// -----------------------------------------------------------------

async function pipeStreamToFile(opts: {
  url: string;
  destPath: string;
  signal: AbortSignal;
  recordingId: string;
  dropChecker: DropChecker;
  /** Append mode — used on retry so we don't clobber pre-failure bytes. */
  append?: boolean;
}): Promise<void> {
  await mkdir(dirname(opts.destPath), { recursive: true });
  const res = await fetch(opts.url, {
    headers: { accept: 'video/mp2t', 'user-agent': 'epghub-recorder' },
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`stream ${opts.url}: HTTP ${res.status}`);
  }
  const out = createWriteStream(opts.destPath, { flags: opts.append ? 'a' : 'w' });
  const reader = res.body.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        const buf = Buffer.from(value);
        opts.dropChecker.feed(buf);
        if (!out.write(buf)) {
          await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

// -----------------------------------------------------------------
// pipeWithRetry — 1× retry policy if the pipe fails within
// RETRY_WINDOW_MS and the recordings row still has retryCount < 2.
// Any second failure — or any failure outside the window — propagates.
// -----------------------------------------------------------------

async function pipeWithRetry(opts: {
  url: string;
  destPath: string;
  recordingId: string;
  rec: ActiveRec;
  startedAt: Date;
}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      const fresh = new AbortController();
      opts.rec.abortCtrl = fresh;
    }
    const signal = opts.rec.abortCtrl.signal;
    try {
      await pipeStreamToFile({
        url: opts.url,
        destPath: opts.destPath,
        signal,
        recordingId: opts.recordingId,
        dropChecker: opts.rec.dropChecker,
        append: attempt > 0,
      });
      return; // clean EOF
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (opts.rec.stopped || e?.name === 'AbortError') throw err;

      const elapsed = Date.now() - opts.startedAt.getTime();
      if (elapsed > RETRY_WINDOW_MS) throw err;
      if (attempt >= MAX_RETRIES) throw err;

      const [row] = await db
        .select({ retryCount: recordings.retryCount })
        .from(recordings)
        .where(eq(recordings.id, opts.recordingId))
        .limit(1);
      const prior = row?.retryCount ?? 0;
      if (prior >= MAX_RETRIES) throw err;

      console.warn(
        `[rec] ${opts.recordingId} stream failed within ${elapsed}ms; retry ${prior + 1}/${MAX_RETRIES}:`,
        e?.message ?? err
      );
      await db
        .update(recordings)
        .set({ retryCount: prior + 1 })
        .where(eq(recordings.id, opts.recordingId))
        .catch(() => undefined);
    }
  }
}
