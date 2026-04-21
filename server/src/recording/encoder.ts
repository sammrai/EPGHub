import { execa, type ExecaError, type ResultPromise } from 'execa';
import { stat, unlink, access } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PRESETS, resolvePreset, type PresetName } from './encodePresets.ts';
import { getGpuStatus } from '../services/gpuProbeService.ts';

// ffmpeg runner.
//
// We spawn ffmpeg with `-progress pipe:1` which makes it emit a machine
// readable key=value stream on stdout, one key per line, with `progress=end`
// marking the last tick. That's much cheaper to parse than the human
// stderr output. We keep stderr captured for error messages but ignore it
// for progress.
//
// Flow:
//   1. Probe the input duration with ffprobe so we can turn `out_time_ms`
//      (microseconds, yes, the name lies — see ffmpeg docs) into a 0..1
//      fraction. If the probe fails (0-byte input / not a real TS) we still
//      run encode but progress stays at 0 until `progress=end`.
//   2. Spawn ffmpeg, stream stdout through a line buffer, call onProgress()
//      with fractions throttled to the caller's cadence (default 5s).
//   3. On exit:
//        - success + raw exists  → unlink raw
//        - failure               → leave raw on disk (operator can retry)
//
// The encoder is intentionally NOT a class. One call = one ffmpeg child.
// Concurrency is controlled upstream by pg-boss batchSize.

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? '/usr/bin/ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN ?? '/usr/bin/ffprobe';

export interface EncodeRunArgs {
  /** Raw .ts input path. */
  inputPath: string;
  /** Preset name (must be a key of PRESETS). */
  preset: PresetName;
  /** Optional explicit output path. Derived from input + preset ext otherwise. */
  outputPath?: string;
  /** Called on every progress tick. progress ∈ [0,1]. */
  onProgress?: (progress: number) => void | Promise<void>;
  /** Minimum ms between onProgress callbacks. Default 5000. */
  progressIntervalMs?: number;
  /** Abort the encode (kills ffmpeg child). */
  signal?: AbortSignal;
}

export interface EncodeResult {
  ok: true;
  outputPath: string;
  durationUs: number;
  rawDeleted: boolean;
}

export interface EncodeFailure {
  ok: false;
  outputPath: string;
  error: string;
  exitCode: number | null;
}

// -----------------------------------------------------------------
// Progress parser — PURE. Exported for unit tests.
//
// ffmpeg emits blocks like:
//   frame=1234
//   fps=29.97
//   bitrate=N/A
//   total_size=...
//   out_time_us=5120000
//   out_time_ms=5120000        ← misnamed upstream; it's actually µs
//   out_time=00:00:05.120000
//   speed=1.5x
//   progress=continue
//
// Each block ends with a `progress=` line. `progress=end` on the last block.
// We normalise everything to a fraction of total_duration_us. Caller passes
// 0 for unknown duration → parser returns `null` progress until `progress=end`.
// -----------------------------------------------------------------

export interface ParsedProgress {
  /** Current fraction in [0,1], or null if unknown (no duration). */
  progress: number | null;
  /** True when ffmpeg emitted `progress=end`. */
  ended: boolean;
}

export function parseProgressLines(buffer: string, totalDurationUs: number): ParsedProgress {
  // State = highest out_time_ms seen + whether we hit `progress=end`.
  // Walk every line; last out_time_ms wins. We also accept `out_time_us`
  // as an alias — older docs used one name, newer ffmpeg uses the other.
  let lastOutTimeUs: number | null = null;
  let ended = false;
  for (const rawLine of buffer.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'out_time_ms' || key === 'out_time_us') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) lastOutTimeUs = n;
    } else if (key === 'progress' && value === 'end') {
      ended = true;
    }
  }
  let progress: number | null = null;
  if (totalDurationUs > 0 && lastOutTimeUs != null) {
    progress = Math.max(0, Math.min(1, lastOutTimeUs / totalDurationUs));
  }
  if (ended && progress == null && totalDurationUs <= 0) {
    // unknown duration case: at least mark 1.0 at the end so callers can
    // render a clean terminal state.
    progress = 1;
  }
  return { progress, ended };
}

// -----------------------------------------------------------------
// ffprobe — grab duration in microseconds. Returns 0 on any failure
// (caller treats that as "unknown duration, skip progress ratio").
// -----------------------------------------------------------------

export async function probeDurationUs(inputPath: string): Promise<number> {
  try {
    const { stdout } = await execa(FFPROBE_BIN, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { reject: false });
    const seconds = Number(String(stdout).trim());
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1_000_000);
    }
    return 0;
  } catch {
    return 0;
  }
}

function deriveOutputPath(inputPath: string, preset: PresetName): string {
  const ext = PRESETS[preset].ext;
  const dir = dirname(inputPath);
  const base = basename(inputPath).replace(/\.[^.]+$/, '');
  return join(dir, `${base}.${ext}`);
}

/**
 * Append `_1`, `_2`, ... before the extension until we find an unused slot.
 * Used to avoid clobbering a prior encode when two recordings land on the
 * same Plex-derived path (e.g. a S/E tuple rerun that kept the clean
 * `Title - sNNeNN.mp4` filename). Mirrors the recorder's collision helper.
 */
async function resolveEncodeCollision(path: string): Promise<string> {
  try {
    await access(path);
  } catch {
    return path;
  }
  const m = path.match(/^(.*)(\.[^./]+)$/);
  const prefix = m ? m[1] : path;
  const ext = m ? m[2] : '';
  console.warn(`[encode] path collision at ${path}; finding free slot`);
  for (let i = 1; i < 100; i++) {
    const candidate = `${prefix}_${i}${ext}`;
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  // Last resort — timestamp-based disambiguator.
  return `${prefix}_${Date.now()}${ext}`;
}

export async function runEncode(opts: EncodeRunArgs): Promise<EncodeResult | EncodeFailure> {
  // Consult the GPU toggle before we resolve args so a CPU preset gets
  // upgraded to its NVENC/VAAPI/QSV counterpart when the admin has flipped
  // `gpu.enabled` + picked a `preferred` encoder. Best-effort: if the DB is
  // unreachable we fall back to the requested CPU preset rather than bail.
  let effectivePresetName: PresetName = opts.preset;
  try {
    const gpuStatus = await getGpuStatus();
    effectivePresetName = resolvePreset(opts.preset, gpuStatus);
  } catch (err) {
    console.warn(`[encode] GPU status lookup failed, using CPU preset: ${(err as Error).message}`);
  }
  if (effectivePresetName !== opts.preset) {
    console.log(`[encode] preset remap ${opts.preset} → ${effectivePresetName} (GPU enabled)`);
  }
  const preset = PRESETS[effectivePresetName];
  if (!preset) {
    return { ok: false, outputPath: '', error: `unknown preset: ${effectivePresetName}`, exitCode: null };
  }

  // Guard: raw input must exist at enqueue time. If it vanished (operator
  // deleted it mid-encode, or a prior encode already consumed it), surface
  // a clean error so the worker flips state='failed' without confusing
  // ffmpeg-level output.
  try {
    await stat(opts.inputPath);
  } catch {
    return {
      ok: false,
      outputPath: '',
      error: `input file missing: ${opts.inputPath}`,
      exitCode: null,
    };
  }

  // When the input is already in the Plex tree (recorder R2+), deriveOutputPath
  // keeps it there — same dir, swapped extension. If a prior encode of the
  // same S/E tuple already claimed the clean path, walk `_1`, `_2`, ... until
  // we find a free slot so we never clobber existing ready content.
  const rawOutputPath = opts.outputPath ?? deriveOutputPath(opts.inputPath, effectivePresetName);
  const outputPath = await resolveEncodeCollision(rawOutputPath);
  const totalDurationUs = await probeDurationUs(opts.inputPath);

  const intervalMs = opts.progressIntervalMs ?? 5000;
  let lastReported = -1;
  let lastReportAt = 0;

  // Construct ffmpeg command:
  //   ffmpeg -y -nostats -progress pipe:1 -i <input> <preset args> <output>
  // `-nostats` silences the noisy stderr; we still capture stderr for errors.
  const args: string[] = [
    '-y',
    '-nostats',
    '-progress', 'pipe:1',
    '-i', opts.inputPath,
    ...preset.args,
    outputPath,
  ];

  let child: ResultPromise<{ reject: false; all: true; buffer: false }> | null = null;
  try {
    child = execa(FFMPEG_BIN, args, {
      reject: false,
      buffer: false,
      all: true,
      cancelSignal: opts.signal,
    }) as unknown as ResultPromise<{ reject: false; all: true; buffer: false }>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, outputPath, error: `spawn failed: ${msg}`, exitCode: null };
  }

  // Line buffer the stdout stream so we parse whole key=value lines only.
  let stdoutBuf = '';
  let stderrTail = '';
  const MAX_STDERR_TAIL = 4096;

  const stdout = child.stdout;
  if (stdout) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const lastNewline = stdoutBuf.lastIndexOf('\n');
      if (lastNewline < 0) return;
      const complete = stdoutBuf.slice(0, lastNewline + 1);
      stdoutBuf = stdoutBuf.slice(lastNewline + 1);
      const { progress, ended } = parseProgressLines(complete, totalDurationUs);
      if (progress != null) {
        const now = Date.now();
        const shouldReport =
          ended ||
          lastReported < 0 ||
          now - lastReportAt >= intervalMs ||
          progress - lastReported >= 0.01;
        if (shouldReport && opts.onProgress) {
          lastReported = progress;
          lastReportAt = now;
          // Fire-and-forget; we don't want DB writes blocking stdout parsing.
          Promise.resolve(opts.onProgress(progress)).catch(() => {});
        }
      }
    });
  }
  const stderr = child.stderr;
  if (stderr) {
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_TAIL);
    });
  }

  const result = await child;
  const exitCode = result.exitCode ?? null;
  const failed = result.failed || exitCode !== 0;

  if (failed) {
    const errMsg =
      (result as ExecaError).shortMessage ??
      stderrTail.trim().split('\n').slice(-4).join('\n') ??
      `ffmpeg exited with code ${exitCode}`;
    // Clean up partial output so a later retry starts fresh. ENOENT fine.
    await unlink(outputPath).catch(() => undefined);
    return { ok: false, outputPath, error: errMsg, exitCode };
  }

  // Sanity-check the output: ffmpeg sometimes exits 0 while producing a
  // zero-byte or truncated mp4 (broken input, SIGTERM mid-write, disk
  // glitch). Treat "clearly bogus" outputs as failure so we don't mark
  // the recording as ready. Keep the raw .ts on disk for a retry; only
  // remove the bogus mp4 so it doesn't masquerade as ready content.
  const MIN_OUTPUT_BYTES = 16 * 1024; // 16 KB
  try {
    const [outStat, inStat] = await Promise.all([
      stat(outputPath),
      stat(opts.inputPath).catch(() => null),
    ]);
    const rawSize = inStat?.size ?? 0;
    const minFromRaw = rawSize > 0 ? Math.floor(rawSize * 0.05) : 0;
    const threshold = Math.max(MIN_OUTPUT_BYTES, minFromRaw);
    if (outStat.size < threshold) {
      const errMsg =
        `encoded output too small: ${outStat.size} bytes (threshold ${threshold}, raw=${rawSize})`;
      console.warn(`[encode] ${outputPath}: ${errMsg}`);
      // Delete the bogus mp4 so it can't masquerade as ready; keep .ts.
      await unlink(outputPath).catch(() => undefined);
      return { ok: false, outputPath, error: errMsg, exitCode };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const errMsg = `encoded output missing after ffmpeg exit 0: ${e?.message ?? String(err)}`;
    console.warn(`[encode] ${outputPath}: ${errMsg}`);
    return { ok: false, outputPath, error: errMsg, exitCode };
  }

  // Fire a final 100% progress tick if we never hit `progress=end` but
  // ffmpeg exited cleanly (some builds stop emitting lines on the last
  // millisecond).
  if (lastReported < 1 && opts.onProgress) {
    try {
      await opts.onProgress(1);
    } catch {
      /* non-fatal */
    }
  }

  let rawDeleted = false;
  try {
    await unlink(opts.inputPath);
    rawDeleted = true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code !== 'ENOENT') {
      // Not fatal — encoded file is fine, we just couldn't reclaim disk.
      // Log via stderr so the worker log carries context.
      console.warn(`[encode] failed to unlink raw ${opts.inputPath}: ${e.message}`);
    }
  }

  return { ok: true, outputPath, durationUs: totalDurationUs, rawDeleted };
}
