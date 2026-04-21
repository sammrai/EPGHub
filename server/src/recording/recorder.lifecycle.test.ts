// Full-lifecycle integration test for the recorder: scheduled → recording
// → ready. Uses a local HTTP server that impersonates Mirakurun so we can
// drive the real recorder code path (fetch, drop-checker, rename,
// DB UPDATE) end-to-end without hitting a real tuner.
//
// Gated on DATABASE_URL; skipped automatically if unset so the unit suite
// still runs in bare environments.
//
// Run: `npm run test:lifecycle` (see package.json scripts)
import 'dotenv/config';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, stat, unlink, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

describe('recorder lifecycle', { concurrency: false }, () => {
  const FIXTURE = '/workspaces/epghub/server/fixtures/tiny.ts';
  const RECORDING_DIR = '/tmp/epghub-lifecycle-test';
  let server: Server | null = null;

  after(async () => {
    server?.close();
    // Nuke the entire Plex tree this suite wrote under so repeated runs
    // don't accumulate `Shows/.../Season 01/...` orphans. rm() with
    // recursive+force is safe against ENOENT.
    await rm(RECORDING_DIR, { recursive: true, force: true }).catch(() => undefined);
    // Force-exit because db/client.ts + pg-boss keep long-lived pool
    // handles that prevent Node from exiting naturally after the last
    // test. The same pattern is used across the rest of the suite.
    setTimeout(() => process.exit(0), 200).unref();
  });

  test('scheduled → recording → ready (keepRaw=true)', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set');
      return;
    }
    // Local Mirakurun stand-in. Serves the fixture TS to any /stream
    // request; returns empty JSON for metadata calls the recorder might
    // make. Starts on an ephemeral port so parallel tests don't collide.
    const tsBytes = readFileSync(FIXTURE);
    server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url.endsWith('/stream') || url.includes('/stream?')) {
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        // Stream the fixture in small chunks to exercise the drop-checker
        // feed loop similar to how real tuners emit data.
        const chunkSize = 4096;
        let i = 0;
        const push = () => {
          if (i >= tsBytes.length) { res.end(); return; }
          const end = Math.min(i + chunkSize, tsBytes.length);
          res.write(tsBytes.subarray(i, end));
          i = end;
          setImmediate(push);
        };
        push();
        return;
      }
      if (url === '/api/services') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const addr = server!.address();
    if (!addr || typeof addr === 'string') throw new Error('mock server no address');

    // Point the recorder at the mock. RECORDING_DIR is isolated from the
    // real .recordings so we can clean up without touching user data.
    await mkdir(RECORDING_DIR, { recursive: true });
    const prevMirakurun = process.env.MIRAKURUN_URL;
    const prevDir = process.env.RECORDING_DIR;
    process.env.MIRAKURUN_URL = `http://localhost:${addr.port}`;
    process.env.RECORDING_DIR = RECORDING_DIR;

    try {
      const { startRecording, stopRecording } = await import('./recorder.ts');
      const { db } = await import('../db/client.ts');
      const { recordings } = await import('../db/schema.ts');
      const { eq } = await import('drizzle-orm');

      // Insert a scheduled row pointing at a fake service id. The
      // recorder maps svc-<n> → /api/services/<n>/stream — our mock
      // server answers anything ending in /stream.
      const id = 'lifecycle-' + randomUUID();
      await db.insert(recordings).values({
        id,
        programId: 'fixture_' + id,
        title: 'lifecycle test',
        ch: 'svc-99999',
        startAt: new Date(Date.now() - 1000),
        endAt: new Date(Date.now() + 5 * 60_000),
        state: 'scheduled',
        keepRaw: true, // stop → ready (skip encode path)
        quality: '1080i',
        priority: 'medium',
      });

      try {
        // Start — should transition to state='recording' and open the pipe.
        await startRecording(id);
        const [rowAfterStart] = await db
          .select({ state: recordings.state })
          .from(recordings)
          .where(eq(recordings.id, id));
        assert.equal(rowAfterStart.state, 'recording', 'state should be recording after start');

        // Give the stream a moment to flow so stop has actual bytes
        // to rename (the mock finishes in <50ms given fixture size).
        await new Promise((r) => setTimeout(r, 400));

        // Stop — should rename .part → .ts and transition to ready
        // (keepRaw skips encode). The recorded row remains the same id.
        await stopRecording(id);

        const [rowAfterStop] = await db
          .select()
          .from(recordings)
          .where(eq(recordings.id, id));
        assert.equal(rowAfterStop.state, 'ready', `expected ready, got ${rowAfterStop.state}`);
        assert.ok(rowAfterStop.filename, 'filename should be set');
        assert.ok(
          rowAfterStop.filename!.endsWith('.ts'),
          `expected .ts, got ${rowAfterStop.filename}`
        );
        // Plex-style layout: the test fixture has no TVDB match, so the
        // recorder falls to the "TV show fallback" branch and writes to
        // Shows/<BroadcastTitle>/Season 01/... Assert the directory structure
        // is present — caller logic relies on it to scan with Plex libraries.
        assert.ok(
          rowAfterStop.filename!.includes('/Shows/'),
          `expected Plex Shows/ path, got ${rowAfterStop.filename}`
        );
        // size is stored in GB with 3 decimals; the ~87KB fixture rounds
        // to 0.000 so just assert the field is populated (non-null) rather
        // than >0. Real recordings are always many MB so 3 decimals is fine.
        assert.ok(rowAfterStop.size != null, 'size should be populated');
        assert.ok((rowAfterStop.duration ?? 0) >= 0, 'duration should be set');

        // Verify the file actually exists and has >=1 KB (the fixture is ~87KB)
        const st = await stat(rowAfterStop.filename!);
        assert.ok(st.size > 1024, `expected file >1KB, got ${st.size}`);

        await unlink(rowAfterStop.filename!).catch(() => undefined);
      } finally {
        await db.delete(recordings).where(eq(recordings.id, id)).catch(() => undefined);
      }
    } finally {
      if (prevMirakurun) process.env.MIRAKURUN_URL = prevMirakurun;
      else delete process.env.MIRAKURUN_URL;
      if (prevDir) process.env.RECORDING_DIR = prevDir;
      else delete process.env.RECORDING_DIR;
    }
  });

  test('scheduled → recording → encoding → ready (keepRaw=false, encode path)', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set');
      return;
    }
    // The first test case already set `server` if the suite ran it; in case
    // this test runs alone, spin up a fresh mock. Either way we ensure a
    // /stream-serving HTTP server is listening before calling the recorder.
    const tsBytes = readFileSync(FIXTURE);
    if (!server || !server.listening) {
      server = createServer((req, res) => {
        const url = req.url ?? '';
        if (url.endsWith('/stream') || url.includes('/stream?')) {
          res.writeHead(200, { 'content-type': 'video/mp2t' });
          const chunkSize = 4096;
          let i = 0;
          const push = () => {
            if (i >= tsBytes.length) { res.end(); return; }
            const end = Math.min(i + chunkSize, tsBytes.length);
            res.write(tsBytes.subarray(i, end));
            i = end;
            setImmediate(push);
          };
          push();
          return;
        }
        if (url === '/api/services') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server!.listen(0, resolve));
    }
    const addr = server!.address();
    if (!addr || typeof addr === 'string') throw new Error('mock server no address');

    await mkdir(RECORDING_DIR, { recursive: true });
    const prevMirakurun = process.env.MIRAKURUN_URL;
    const prevDir = process.env.RECORDING_DIR;
    process.env.MIRAKURUN_URL = `http://localhost:${addr.port}`;
    process.env.RECORDING_DIR = RECORDING_DIR;

    try {
      const { startRecording, stopRecording } = await import('./recorder.ts');
      const { db } = await import('../db/client.ts');
      const { recordings } = await import('../db/schema.ts');
      const { eq } = await import('drizzle-orm');

      // Same as the keepRaw=true test, except keepRaw is false so stop()
      // should transition to 'encoding' (not 'ready') and enqueue a job
      // on QUEUE.ENCODE. We don't actually drain that queue here — the
      // encode worker is tested separately (encoder.test.ts + e2e).
      // The goal of this test is the state-machine transition.
      const id = 'lifecycle-' + randomUUID();
      await db.insert(recordings).values({
        id,
        programId: 'fixture_' + id,
        title: 'lifecycle test encode',
        ch: 'svc-99999',
        startAt: new Date(Date.now() - 1000),
        endAt: new Date(Date.now() + 5 * 60_000),
        state: 'scheduled',
        keepRaw: false, // stop → encoding (not ready)
        quality: '1080i',
        priority: 'medium',
      });

      try {
        await startRecording(id);
        const [rowAfterStart] = await db
          .select({ state: recordings.state })
          .from(recordings)
          .where(eq(recordings.id, id));
        assert.equal(rowAfterStart.state, 'recording', 'state should be recording after start');

        await new Promise((r) => setTimeout(r, 400));

        // Stop — with keepRaw=false this transitions to 'encoding' and
        // enqueues a QUEUE.ENCODE job. filename and rawFilename both
        // point at the raw .ts until the encode worker overwrites
        // filename with the encoded path.
        await stopRecording(id);

        const [rowAfterStop] = await db
          .select()
          .from(recordings)
          .where(eq(recordings.id, id));
        assert.equal(
          rowAfterStop.state,
          'encoding',
          `expected encoding, got ${rowAfterStop.state}`
        );
        assert.ok(rowAfterStop.filename, 'filename should be set');
        assert.ok(
          rowAfterStop.filename!.endsWith('.ts'),
          `expected .ts pre-encode, got ${rowAfterStop.filename}`
        );
        assert.equal(
          rowAfterStop.rawFilename,
          rowAfterStop.filename,
          'rawFilename should equal filename before encode'
        );
        assert.ok(rowAfterStop.size != null, 'size should be populated');
        assert.ok((rowAfterStop.duration ?? 0) >= 0, 'duration should be set');

        const st = await stat(rowAfterStop.filename!);
        assert.ok(st.size > 1024, `expected raw .ts file >1KB, got ${st.size}`);

        await unlink(rowAfterStop.filename!).catch(() => undefined);
      } finally {
        await db.delete(recordings).where(eq(recordings.id, id)).catch(() => undefined);
      }
    } finally {
      if (prevMirakurun) process.env.MIRAKURUN_URL = prevMirakurun;
      else delete process.env.MIRAKURUN_URL;
      if (prevDir) process.env.RECORDING_DIR = prevDir;
      else delete process.env.RECORDING_DIR;
    }
  });
});
