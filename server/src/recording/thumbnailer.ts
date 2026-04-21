import { execa } from 'execa';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// ffmpeg thumbnail extractor.
//
// Pulls a single frame from `inputPath` at `seekSec` (default 60s) and
// writes it as a JPEG to `outputPath`. Returns true on success, false on
// any failure — we never throw, because the caller (thumbnail worker)
// treats a missing thumbnail as "render the TVDB poster fallback" rather
// than a hard error.
//
// Falls back to `-ss 00:00:00` when the video is shorter than seekSec,
// which matters for short clips / fixture TS files used in the test suite.
//
// Adapted from EPGStation/src/model/operator/thumbnail/ThumbnailManageModel.ts
// but intentionally much simpler: we have a single output format (JPEG)
// and don't need the %TEMPLATE% command string expansion.

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? '/usr/bin/ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN ?? '/usr/bin/ffprobe';

/** Probe duration in seconds. Returns 0 on any failure. */
async function probeDurationSec(inputPath: string): Promise<number> {
  try {
    const { stdout } = await execa(
      FFPROBE_BIN,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ],
      { reject: false }
    );
    const seconds = Number(String(stdout).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch {
    return 0;
  }
}

function formatSeek(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(safe / 3600)).padStart(2, '0');
  const mm = String(Math.floor((safe % 3600) / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Extract a single JPEG frame via ffmpeg.
 *
 * @returns true on success (output file exists and is non-empty).
 */
export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  seekSec: number = 60
): Promise<boolean> {
  try {
    await stat(inputPath);
  } catch (err) {
    console.warn(
      `[thumbnail] input missing: ${inputPath} (${(err as Error).message})`
    );
    return false;
  }

  // If the clip is shorter than the requested seek, grab the very first
  // frame instead — otherwise ffmpeg seeks past EOF and produces an empty
  // image (or fails outright).
  let effectiveSeek = seekSec;
  const durationSec = await probeDurationSec(inputPath);
  if (durationSec > 0 && durationSec <= seekSec) {
    effectiveSeek = 0;
  }

  try {
    await mkdir(dirname(outputPath), { recursive: true });
  } catch (err) {
    console.warn(
      `[thumbnail] mkdir ${dirname(outputPath)} failed: ${(err as Error).message}`
    );
    return false;
  }

  // Note: `-ss` placed *before* `-i` uses the faster input-seek which is
  // usually accurate enough for preview frames. `-frames:v 1` caps output
  // to a single picture. `-y` overwrites any previous run.
  const args = [
    '-y',
    '-ss', formatSeek(effectiveSeek),
    '-i', inputPath,
    '-frames:v', '1',
    '-q:v', '3',
    outputPath,
  ];

  try {
    const result = await execa(FFMPEG_BIN, args, { reject: false, all: true });
    if ((result.exitCode ?? 1) !== 0) {
      const tail = String(result.all ?? result.stderr ?? '').split('\n').slice(-4).join('\n');
      console.warn(
        `[thumbnail] ffmpeg exit=${result.exitCode} input=${inputPath}\n${tail}`
      );
      return false;
    }
  } catch (err) {
    console.warn(`[thumbnail] ffmpeg spawn failed: ${(err as Error).message}`);
    return false;
  }

  try {
    const st = await stat(outputPath);
    if (!st.isFile() || st.size <= 0) {
      console.warn(`[thumbnail] output empty or not a file: ${outputPath}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `[thumbnail] output stat failed ${outputPath}: ${(err as Error).message}`
    );
    return false;
  }
}
