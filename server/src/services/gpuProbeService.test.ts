// GPU probe service tests. On the devcontainer there is no real GPU, so all
// 8 probes should fail-fast (VAAPI without /dev/dri/renderD128, NVENC without
// CUDA libs, etc.). The test asserts the RESULT SHAPE — not a specific list
// of encoders — so it's stable across environments.
//
// Run: npm run test:gpu-probe
//   (which is just `node --import tsx --test src/services/gpuProbeService.test.ts`)
//
// Some test paths exercise the DB (setGpuSettings / getGpuStatus). If
// DATABASE_URL isn't set we skip those rather than hang on client init.

import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { eq } from 'drizzle-orm';

// Lazy-imported so DATABASE_URL is consulted only if it's set — without
// this wrapper, the top-level import of gpuProbeService.ts would pull in
// db/client.ts and throw on missing env before any test ran.
let svc: typeof import('./gpuProbeService.ts') | null = null;
async function loadSvc() {
  if (!svc) svc = await import('./gpuProbeService.ts');
  return svc;
}

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? '/usr/bin/ffmpeg';

async function canAccess(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

describe('gpuProbeService', { concurrency: false }, () => {
  let haveFfmpeg = false;
  let haveDb = false;
  let db: typeof import('../db/client.ts').db | null = null;
  let systemSettings: typeof import('../db/schema.ts').systemSettings | null = null;

  before(async () => {
    haveFfmpeg = await canAccess(FFMPEG_BIN);
    haveDb = Boolean(process.env.DATABASE_URL);
    if (haveDb) {
      const client = await import('../db/client.ts');
      const schema = await import('../db/schema.ts');
      db = client.db;
      systemSettings = schema.systemSettings;
    }
  });

  after(async () => {
    // Clean up gpu.* rows so the DB doesn't accumulate test state.
    if (db && systemSettings) {
      for (const key of ['gpu.enabled', 'gpu.preferred', 'gpu.lastProbe']) {
        await db.delete(systemSettings).where(eq(systemSettings.key, key)).catch(() => undefined);
      }
    }
    // Some drivers (pg-boss imports) keep the event loop alive. Force-exit so
    // the test runner doesn't hang past the assertions.
    setTimeout(() => process.exit(0), 200).unref();
  });

  test('probeGpu returns a stable shape (devcontainer likely has no GPU)', async (t) => {
    if (!haveFfmpeg) return t.skip('ffmpeg not installed');
    if (!haveDb)    return t.skip('DATABASE_URL not set');

    const { probeGpu, ALL_GPU_ENCODERS } = await loadSvc();
    const result = await probeGpu();

    assert.ok(Array.isArray(result.available), 'available is an array');
    // details must list every encoder key, even the ones that failed.
    for (const enc of ALL_GPU_ENCODERS) {
      assert.ok(enc in result.details, `details missing ${enc}`);
      const d = result.details[enc];
      assert.equal(typeof d.ok, 'boolean');
      if (!d.ok) {
        // Failed probes must carry a short error string for the UI.
        assert.equal(typeof d.error, 'string');
      }
    }
    // probedAt must be parseable as ISO-8601.
    assert.ok(!Number.isNaN(Date.parse(result.probedAt)), 'probedAt is ISO');
    // `available` must be a subset of keys flagged ok in details.
    for (const enc of result.available) {
      assert.equal(result.details[enc].ok, true, `${enc} in available but details says not ok`);
    }
  });

  test('setGpuSettings persists then getGpuStatus reflects them', async (t) => {
    if (!haveDb) return t.skip('DATABASE_URL not set');

    const { setGpuSettings, getGpuStatus } = await loadSvc();
    await setGpuSettings({ enabled: true, preferred: 'hevc_nvenc' });
    const status = await getGpuStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.preferred, 'hevc_nvenc');

    // Null preferred should round-trip (admin un-picking the encoder).
    await setGpuSettings({ preferred: null });
    const status2 = await getGpuStatus();
    assert.equal(status2.preferred, null);
    assert.equal(status2.enabled, true, 'enabled unchanged when only preferred is patched');

    // Flip back to off.
    await setGpuSettings({ enabled: false });
    const status3 = await getGpuStatus();
    assert.equal(status3.enabled, false);
  });
});
