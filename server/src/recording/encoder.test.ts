// Unit tests for the ffmpeg progress parser. We deliberately do NOT spawn
// ffmpeg here — that lives in the e2e suite.
//
// The failure-path tests below DO spawn ffmpeg because they're exercising
// the encoder's wrapper behaviour (error capture, raw-preservation,
// under-threshold detection). They only run when /usr/bin/ffmpeg exists
// and use sub-second inputs so total runtime stays small.
//
// Run: `npm run test:unit` (or `node --import tsx --test src/recording/encoder.test.ts`)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { parseProgressLines, runEncode } from './encoder.ts';
import { resolvePreset } from './encodePresets.ts';

describe('parseProgressLines', () => {
  test('51.2% at 5.12s of a 10s encode', () => {
    const buf = 'out_time_ms=5120000\nspeed=1.5x\nprogress=continue\n';
    const { progress, ended } = parseProgressLines(buf, 10_000_000);
    assert.equal(ended, false);
    assert.ok(progress != null);
    assert.ok(Math.abs(progress! - 0.512) < 1e-9, `expected 0.512 got ${progress}`);
  });

  test('progress=end marks ended', () => {
    const buf = 'out_time_ms=9999000\nprogress=end\n';
    const { ended } = parseProgressLines(buf, 10_000_000);
    assert.equal(ended, true);
  });

  test('accepts out_time_us alias', () => {
    const buf = 'out_time_us=2500000\nprogress=continue\n';
    const { progress } = parseProgressLines(buf, 10_000_000);
    assert.equal(progress, 0.25);
  });

  test('unknown duration returns null progress until end', () => {
    const buf = 'out_time_ms=5000000\nprogress=continue\n';
    const { progress, ended } = parseProgressLines(buf, 0);
    assert.equal(progress, null);
    assert.equal(ended, false);
  });

  test('unknown duration + progress=end returns 1.0', () => {
    const buf = 'out_time_ms=5000000\nprogress=end\n';
    const { progress, ended } = parseProgressLines(buf, 0);
    assert.equal(progress, 1);
    assert.equal(ended, true);
  });

  test('clamps to [0,1] when ffmpeg overshoots duration', () => {
    const buf = 'out_time_ms=15000000\nprogress=continue\n';
    const { progress } = parseProgressLines(buf, 10_000_000);
    assert.equal(progress, 1);
  });

  test('picks the latest out_time_ms across multiple blocks', () => {
    const buf = [
      'frame=1',
      'out_time_ms=1000000',
      'progress=continue',
      'frame=2',
      'out_time_ms=4000000',
      'progress=continue',
    ].join('\n');
    const { progress } = parseProgressLines(buf, 10_000_000);
    assert.equal(progress, 0.4);
  });

  test('ignores malformed lines', () => {
    const buf = 'garbage\n=nokey\nout_time_ms=not-a-number\nout_time_ms=3000000\nprogress=continue';
    const { progress } = parseProgressLines(buf, 10_000_000);
    assert.equal(progress, 0.3);
  });

  test('empty input returns null + not ended', () => {
    const r = parseProgressLines('', 10_000_000);
    assert.deepEqual(r, { progress: null, ended: false });
  });
});

// -----------------------------------------------------------------
// resolvePreset — maps a CPU preset to its GPU variant at encode time when
// the admin has flipped `gpu.enabled` and picked a `preferred` encoder.
// Kept in-process (pure) so this test doesn't need a DB.
// -----------------------------------------------------------------

describe('resolvePreset', () => {
  test('disabled status is a no-op', () => {
    assert.equal(
      resolvePreset('h265-1080p', { enabled: false, preferred: 'hevc_nvenc', lastProbe: null }),
      'h265-1080p',
    );
  });

  test('enabled + preferred=hevc_nvenc maps h265-1080p → h265-1080p-nvenc', () => {
    const got = resolvePreset('h265-1080p', {
      enabled: true,
      preferred: 'hevc_nvenc',
      lastProbe: null,
    });
    assert.equal(got, 'h265-1080p-nvenc');
  });

  test('enabled + preferred=h264_vaapi maps h264-720p → h264-720p-vaapi', () => {
    const got = resolvePreset('h264-720p', {
      enabled: true,
      preferred: 'h264_vaapi',
      lastProbe: null,
    });
    assert.equal(got, 'h264-720p-vaapi');
  });

  test('enabled + preferred=hevc_qsv maps h265-1080p → h265-1080p-qsv', () => {
    const got = resolvePreset('h265-1080p', {
      enabled: true,
      preferred: 'hevc_qsv',
      lastProbe: null,
    });
    assert.equal(got, 'h265-1080p-qsv');
  });

  test('codec family mismatch falls back to CPU preset', () => {
    // preferred=h264_nvenc shouldn't remap an h265 preset (we'd switch codecs).
    const got = resolvePreset('h265-1080p', {
      enabled: true,
      preferred: 'h264_nvenc',
      lastProbe: null,
    });
    assert.equal(got, 'h265-1080p');
  });

  test('audio-only is never remapped', () => {
    assert.equal(
      resolvePreset('audio-only', { enabled: true, preferred: 'hevc_nvenc', lastProbe: null }),
      'audio-only',
    );
  });

  test('videotoolbox has no presets — falls back to CPU', () => {
    const got = resolvePreset('h265-1080p', {
      enabled: true,
      preferred: 'hevc_videotoolbox',
      lastProbe: null,
    });
    assert.equal(got, 'h265-1080p');
  });

  test('null preferred is a no-op', () => {
    assert.equal(
      resolvePreset('h265-1080p', { enabled: true, preferred: null, lastProbe: null }),
      'h265-1080p',
    );
  });

  test('null status is a no-op', () => {
    assert.equal(resolvePreset('h265-1080p', null), 'h265-1080p');
  });
});

// -----------------------------------------------------------------
// Failure-path integration tests. These actually spawn ffmpeg, so we
// gate on the binary being present to keep CI/dev environments without
// it green.
// -----------------------------------------------------------------

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? '/usr/bin/ffmpeg';
const FIXTURE_TS = new URL('../../fixtures/tiny.ts', import.meta.url).pathname;

async function canAccess(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('runEncode failure paths', { concurrency: false }, () => {
  let tmpRoot: string | null = null;
  let haveFfmpeg = false;

  before(async () => {
    haveFfmpeg = await canAccess(FFMPEG_BIN);
    if (!haveFfmpeg) return;
    tmpRoot = await mkdtemp(join(tmpdir(), 'encoder-test-'));
  });

  after(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('ffmpeg exits non-zero on corrupt input — raw .ts is preserved', async (t) => {
    if (!haveFfmpeg || !tmpRoot) return t.skip('ffmpeg not available');

    // 188 null bytes: passes stat() but ffmpeg rejects with
    // "Invalid data found when processing input" → non-zero exit.
    const rawPath = join(tmpRoot, 'corrupt.ts');
    await writeFile(rawPath, Buffer.alloc(188, 0));

    const result = await runEncode({ inputPath: rawPath, preset: 'audio-only' });

    assert.equal(result.ok, false, 'expected failure');
    if (result.ok) return; // type narrow
    assert.notEqual(result.exitCode, 0, `exitCode should be non-zero, got ${result.exitCode}`);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, 'error string should not be empty');
    // Raw must still exist so the operator can retry.
    assert.equal(await fileExists(rawPath), true, 'raw .ts must survive ffmpeg failure');
    // Partial/empty output (if any) must be cleaned up.
    assert.equal(
      await fileExists(result.outputPath),
      false,
      'partial output must be cleaned up on failure',
    );
  });

  test('output below size threshold is rejected — raw .ts preserved', async (t) => {
    if (!haveFfmpeg || !tmpRoot) return t.skip('ffmpeg not available');

    // Build a ~100ms silent source stored with a .ts-ish extension so
    // deriveOutputPath() produces a distinct .m4a target. Re-encoding
    // with `audio-only` yields an m4a well under the 16KB floor, which
    // exercises the stat() post-check branch.
    const rawPath = join(tmpRoot, 'tiny-silence.ts');
    await execa(FFMPEG_BIN, [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=duration=0.1:sample_rate=8000',
      '-c:a', 'aac', '-b:a', '16k', '-f', 'mpegts', rawPath,
    ], { reject: false });

    const rawBefore = await stat(rawPath);
    assert.ok(rawBefore.size > 0 && rawBefore.size < 16 * 1024,
      `test input must be small; got ${rawBefore.size}`);

    const result = await runEncode({ inputPath: rawPath, preset: 'audio-only' });

    assert.equal(result.ok, false, 'expected failure on under-threshold output');
    if (result.ok) return;
    assert.ok(
      /too small|missing after ffmpeg/.test(result.error),
      `error should mention size/missing, got: ${result.error}`,
    );
    // Raw preserved so a later retry can start fresh.
    assert.equal(await fileExists(rawPath), true, 'raw must survive size-check failure');
    // Bogus output scrubbed so it can't masquerade as ready content.
    assert.equal(
      await fileExists(result.outputPath),
      false,
      'under-threshold output must be deleted',
    );
  });

  test('missing input file returns failure without throwing', async () => {
    const missing = '/definitely/does/not/exist/nowhere.ts';

    // Must not throw.
    const result = await runEncode({ inputPath: missing, preset: 'audio-only' });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.exitCode, null, 'exitCode=null when we bail pre-spawn');
    assert.match(result.error, /input file missing/);
  });

  test('corrupt input leaves the real fixture unharmed when copied', async (t) => {
    // Sanity: using the shipped tiny.ts as raw and forcing ffmpeg into a
    // bad cmdline would be ideal, but we can't inject args via the public
    // API. Instead, confirm our copy-then-fail flow doesn't touch the
    // source fixture — important because other tests depend on it.
    if (!haveFfmpeg || !tmpRoot) return t.skip('ffmpeg not available');
    if (!(await canAccess(FIXTURE_TS))) return t.skip('tiny.ts fixture missing');

    const rawPath = join(tmpRoot, 'copy-of-tiny.ts');
    await copyFile(FIXTURE_TS, rawPath);
    // Truncate the copy to 188 bytes so ffmpeg fails.
    await writeFile(rawPath, Buffer.alloc(188, 0));

    const result = await runEncode({ inputPath: rawPath, preset: 'audio-only' });
    assert.equal(result.ok, false);
    // Original fixture untouched.
    const fixtureStat = await stat(FIXTURE_TS);
    assert.ok(fixtureStat.size > 80_000, 'fixture must remain intact');
  });
});
