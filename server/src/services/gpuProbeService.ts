// GPU probe service — detects which hardware ffmpeg encoders are usable on
// the host by actually running a 0.5s null encode per candidate. Result is
// persisted to `system_settings` so the Settings page doesn't re-probe on
// every page load (probing spawns 8 ffmpeg children in parallel, ~1s even
// when everything fails fast).
//
// We expose three keys under the `gpu.*` namespace:
//   gpu.enabled    (bool)           — master toggle the encoder checks
//   gpu.preferred  (GpuEncoder|null) — which encoder resolvePreset() should prefer
//   gpu.lastProbe  (GpuProbeResult)  — cached result for the UI
//
// On a devcontainer without a GPU (or without /dev/dri/renderD128 for VAAPI
// / without CUDA libs for NVENC) every probe will fail. That's fine — the
// result just reports `available=[]` and the UI keeps the toggle disabled.

import { execa } from 'execa';
import { eq, sql } from 'drizzle-orm';

// DB bindings are resolved lazily: importing ../db/client.ts throws when
// DATABASE_URL is unset (e.g. from the `encoder.test.ts` pure progress-
// parser tests, which don't need any DB access). By deferring the import
// until an actual read/write happens, we keep the encoder's gpu-status
// lookup a soft dependency.
type DbClient = typeof import('../db/client.ts').db;
type SystemSettings = typeof import('../db/schema.ts').systemSettings;
let _db: DbClient | null = null;
let _systemSettings: SystemSettings | null = null;
async function dbHandles(): Promise<{ db: DbClient; systemSettings: SystemSettings }> {
  if (!_db || !_systemSettings) {
    const client = await import('../db/client.ts');
    const schema = await import('../db/schema.ts');
    _db = client.db;
    _systemSettings = schema.systemSettings;
  }
  return { db: _db, systemSettings: _systemSettings };
}

export type GpuEncoder =
  | 'h264_nvenc' | 'hevc_nvenc'
  | 'h264_vaapi' | 'hevc_vaapi'
  | 'h264_qsv'   | 'hevc_qsv'
  | 'h264_videotoolbox' | 'hevc_videotoolbox';

export const ALL_GPU_ENCODERS: readonly GpuEncoder[] = [
  'h264_nvenc', 'hevc_nvenc',
  'h264_vaapi', 'hevc_vaapi',
  'h264_qsv',   'hevc_qsv',
  'h264_videotoolbox', 'hevc_videotoolbox',
] as const;

export interface GpuProbeDetail {
  ok: boolean;
  error?: string;
}

export interface GpuProbeResult {
  available: GpuEncoder[];
  details: Record<GpuEncoder, GpuProbeDetail>;
  probedAt: string; // ISO
}

export interface GpuSettings {
  enabled: boolean;
  preferred: GpuEncoder | null;
  lastProbe: GpuProbeResult | null;
}

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? '/usr/bin/ffmpeg';

// Key names in system_settings. Collected here so tests can clean up.
const KEY_ENABLED    = 'gpu.enabled';
const KEY_PREFERRED  = 'gpu.preferred';
const KEY_LAST_PROBE = 'gpu.lastProbe';

// Per-encoder ffmpeg argv. VAAPI needs an explicit render node init; others
// are happy with just `-c:v <encoder>`. We use lavfi's `testsrc` so there's
// no file dependency and the duration is capped at 0.5s. `-f null -` eats
// the output without touching disk.
function buildProbeArgs(encoder: GpuEncoder): string[] {
  const common = [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc=duration=0.5:size=128x96:rate=10',
  ];
  if (encoder.endsWith('_vaapi')) {
    // VAAPI probes: init the device and upload frames to GPU memory.
    return [
      '-hide_banner',
      '-loglevel', 'error',
      '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
      '-filter_hw_device', 'va',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=0.5:size=128x96:rate=10',
      '-vf', 'format=nv12,hwupload',
      '-c:v', encoder,
      '-f', 'null', '-',
    ];
  }
  return [...common, '-c:v', encoder, '-f', 'null', '-'];
}

async function probeOne(encoder: GpuEncoder, timeoutMs: number): Promise<GpuProbeDetail> {
  try {
    const result = await execa(FFMPEG_BIN, buildProbeArgs(encoder), {
      reject: false,
      timeout: timeoutMs,
      all: true,
    });
    if (result.exitCode === 0) {
      return { ok: true };
    }
    const stderr = String(result.stderr ?? result.all ?? '').trim();
    const msg = stderr.split('\n').slice(-3).join(' ').slice(0, 300) || `exit ${result.exitCode}`;
    return { ok: false, error: msg };
  } catch (err) {
    // ENOENT on ffmpeg, spawn errors, etc. classify as "not available".
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 300) };
  }
}

/**
 * Run every GPU probe in parallel (timeout 5s each by default), persist the
 * result to `system_settings.gpu.lastProbe`, auto-seed `gpu.preferred` with
 * the first available encoder when unset, and return the result.
 */
export async function probeGpu(timeoutMs = 5000): Promise<GpuProbeResult> {
  const entries = await Promise.all(
    ALL_GPU_ENCODERS.map(async (enc) => [enc, await probeOne(enc, timeoutMs)] as const),
  );
  const details = Object.fromEntries(entries) as Record<GpuEncoder, GpuProbeDetail>;
  const available = entries.filter(([, d]) => d.ok).map(([e]) => e);
  const result: GpuProbeResult = {
    available,
    details,
    probedAt: new Date().toISOString(),
  };

  // Persist. Use upsert so repeated probes just overwrite the row.
  await upsertSetting(KEY_LAST_PROBE, result);

  // If no preferred yet, or the current preferred is no longer available,
  // auto-pick the first available encoder. Never downgrade to null when the
  // admin explicitly picked something though — we only nudge on first run.
  const current = await getSetting<GpuEncoder | null>(KEY_PREFERRED);
  if (current === undefined && available.length > 0) {
    await upsertSetting(KEY_PREFERRED, available[0]);
  }

  return result;
}

/** Return current toggle, preferred encoder, and last cached probe. */
export async function getGpuStatus(): Promise<GpuSettings> {
  const [enabledRaw, preferredRaw, lastProbeRaw] = await Promise.all([
    getSetting<boolean>(KEY_ENABLED),
    getSetting<GpuEncoder | null>(KEY_PREFERRED),
    getSetting<GpuProbeResult>(KEY_LAST_PROBE),
  ]);
  return {
    enabled: enabledRaw === true,
    preferred: preferredRaw ?? null,
    lastProbe: lastProbeRaw ?? null,
  };
}

/** Patch-style update. Only writes keys the caller explicitly sends. */
export async function setGpuSettings(patch: {
  enabled?: boolean;
  preferred?: GpuEncoder | null;
}): Promise<void> {
  if (patch.enabled !== undefined) {
    await upsertSetting(KEY_ENABLED, patch.enabled);
  }
  if (patch.preferred !== undefined) {
    await upsertSetting(KEY_PREFERRED, patch.preferred);
  }
}

// -----------------------------------------------------------------
// Low-level helpers over the system_settings key/value store.
// -----------------------------------------------------------------

async function getSetting<T>(key: string): Promise<T | undefined> {
  const { db, systemSettings } = await dbHandles();
  const rows = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key));
  if (rows.length === 0) return undefined;
  return rows[0].value as T;
}

async function upsertSetting(key: string, value: unknown): Promise<void> {
  const { db, systemSettings } = await dbHandles();
  // drizzle's jsonb column treats a JS `null` as SQL NULL, which violates
  // the NOT NULL constraint on system_settings.value. Wrap in a literal
  // `null::jsonb` cast so the JSON null reaches Postgres as a jsonb value.
  // Other values (booleans, strings, objects) serialise cleanly through
  // the driver's JSON encoding.
  const jsonbVal =
    value === null ? sql`'null'::jsonb` : (value as never);
  await db
    .insert(systemSettings)
    .values({ key, value: jsonbVal, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: jsonbVal, updatedAt: new Date() },
    });
}
