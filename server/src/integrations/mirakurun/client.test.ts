// Unit tests for the Mirakurun SSE parser in HttpMirakurunClient.eventsStream.
//
// Mirakurun's /api/events/stream is not canonical SSE: it sends a JSON array
// framed like `[\n{…},\n{…}\n]`. We spin up a tiny local HTTP server, point
// the client at it, and assert that the parser yields the expected sequence
// of onEvent callbacks across happy-path, chunked, empty, malformed, mid-
// stream-close, and caller-close() scenarios.
//
// Run: `npm run test:mirakurun`
//
// (Pure framing test: no DB, no fixtures, no env vars needed.)

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpMirakurunClient, type MrEvent } from './client.ts';

// Each test spins up its own server so ports never collide and the body can
// be shaped per-case. `handler` decides how to respond to /api/events/stream.
type Handler = (res: http.ServerResponse, req: http.IncomingMessage) => void;

async function withServer<T>(
  handler: Handler,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/events/stream') {
      handler(res, req);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    // Force-close any lingering sockets so server.close() resolves promptly.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Wait until `predicate()` is true or `timeoutMs` elapses. Polls every 5 ms.
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Collector struct shared across tests — keeps callback signatures identical.
function makeCollector() {
  const events: MrEvent[] = [];
  const errors: unknown[] = [];
  let openCount = 0;
  return {
    events,
    errors,
    get openCount() { return openCount; },
    handlers: {
      onEvent: (ev: MrEvent) => { events.push(ev); },
      onError: (err: unknown) => { errors.push(err); },
      onOpen: () => { openCount += 1; },
    },
    // Assertion helper so each test reads the same way.
    assertOpenOnce(): void {
      assert.equal(openCount, 1, 'onOpen should fire exactly once');
    },
  };
}

test('happy path: 3 well-formed events', async () => {
  const body =
    '[\n' +
    '{"resource":"program","type":"create","data":{"id":1}},\n' +
    '{"resource":"program","type":"update","data":{"id":2}},\n' +
    '{"resource":"service","type":"create","data":{"id":3}}\n' +
    ']';

  await withServer(
    (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    },
    async (baseUrl) => {
      const c = makeCollector();
      const client = new HttpMirakurunClient(baseUrl);
      const stream = client.eventsStream(c.handlers);
      await waitUntil(() => c.events.length >= 3);
      stream.close();

      assert.equal(c.events.length, 3);
      assert.deepEqual(c.events[0], { resource: 'program', type: 'create', data: { id: 1 } });
      assert.deepEqual(c.events[1], { resource: 'program', type: 'update', data: { id: 2 } });
      assert.deepEqual(c.events[2], { resource: 'service', type: 'create', data: { id: 3 } });
      c.assertOpenOnce();
      assert.equal(c.errors.length, 0, 'onError should not fire for well-formed input');
    }
  );
});

test('chunked delivery: 2-byte slices still yield 3 events', async () => {
  const body =
    '[\n' +
    '{"resource":"program","type":"create","data":{"id":10}},\n' +
    '{"resource":"program","type":"update","data":{"id":20}},\n' +
    '{"resource":"service","type":"create","data":{"id":30}}\n' +
    ']';

  await withServer(
    (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      let i = 0;
      const pump = (): void => {
        if (i >= body.length) { res.end(); return; }
        const slice = body.slice(i, i + 2);
        i += 2;
        // Wait for the slice to actually flush (write callback) before
        // scheduling the next one. Combined with setImmediate this keeps
        // slices in separate TCP segments rather than getting coalesced.
        res.write(slice, () => setImmediate(pump));
      };
      pump();
    },
    async (baseUrl) => {
      const c = makeCollector();
      const client = new HttpMirakurunClient(baseUrl);
      const stream = client.eventsStream(c.handlers);
      await waitUntil(() => c.events.length >= 3, 3000);
      stream.close();

      assert.equal(c.events.length, 3);
      assert.equal((c.events[0].data as { id: number }).id, 10);
      assert.equal((c.events[1].data as { id: number }).id, 20);
      assert.equal((c.events[2].data as { id: number }).id, 30);
      c.assertOpenOnce();
      assert.equal(c.errors.length, 0);
    }
  );
});

test('single-event body: 1 event', async () => {
  const body = '[\n{"resource":"program","type":"update","data":{"id":42}}\n]';

  await withServer(
    (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    },
    async (baseUrl) => {
      const c = makeCollector();
      const client = new HttpMirakurunClient(baseUrl);
      const stream = client.eventsStream(c.handlers);
      await waitUntil(() => c.events.length >= 1);
      stream.close();

      assert.equal(c.events.length, 1);
      assert.deepEqual(c.events[0], { resource: 'program', type: 'update', data: { id: 42 } });
      c.assertOpenOnce();
      assert.equal(c.errors.length, 0);
    }
  );
});

test('empty body: `[\\n]` yields 0 events and no error', async () => {
  const body = '[\n]';

  await withServer(
    (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    },
    async (baseUrl) => {
      const c = makeCollector();
      const client = new HttpMirakurunClient(baseUrl);
      const stream = client.eventsStream(c.handlers);
      // Body is tiny; give it a moment to finish parsing.
      await new Promise((r) => setTimeout(r, 50));
      stream.close();

      assert.equal(c.events.length, 0);
      c.assertOpenOnce();
      assert.equal(c.errors.length, 0);
    }
  );
});

test('malformed JSON in one frame: onError fires, subsequent frames still parse', async () => {
  // Middle frame has a trailing comma inside `data` → JSON.parse throws.
  // The parser uses a brace-counting scanner (not JSON-aware), so it still
  // finds the frame boundary, calls onError for the bad frame, and continues.
  const body =
    '[\n' +
    '{"resource":"program","type":"create","data":{"id":1}},\n' +
    '{"resource":"program","type":"update","data":{"id":2,}},\n' +
    '{"resource":"service","type":"create","data":{"id":3}}\n' +
    ']';

  await withServer(
    (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    },
    async (baseUrl) => {
      const c = makeCollector();
      const client = new HttpMirakurunClient(baseUrl);
      const stream = client.eventsStream(c.handlers);
      await waitUntil(() => c.events.length >= 2 && c.errors.length >= 1, 2000);
      stream.close();

      // Two good frames delivered; the malformed one surfaces as onError.
      assert.equal(c.events.length, 2);
      assert.equal((c.events[0].data as { id: number }).id, 1);
      assert.equal((c.events[1].data as { id: number }).id, 3);
      assert.equal(c.errors.length, 1);
      assert.ok(c.errors[0] instanceof SyntaxError, 'expected JSON SyntaxError');
      c.assertOpenOnce();
    }
  );
});

test('connection closes mid-stream: partial frame not emitted', async () => {
  // Send one good frame, then half of a second frame, then drop the socket.
  const head =
    '[\n' +
    '{"resource":"program","type":"create","data":{"id":7}},\n' +
    '{"resource":"program","type":"upda';

  await withServer(
    (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(head);
      // Close the underlying socket without a clean end so the client sees
      // the stream terminate mid-frame.
      setImmediate(() => res.destroy());
    },
    async (baseUrl) => {
      const c = makeCollector();
      const client = new HttpMirakurunClient(baseUrl);
      const stream = client.eventsStream(c.handlers);
      // Wait for either the complete first event or an error to settle.
      await waitUntil(() => c.events.length >= 1, 2000);
      // Give the abort/error path a tick to run.
      await new Promise((r) => setTimeout(r, 50));
      stream.close();

      // Exactly one full event delivered; the partial second frame is dropped.
      assert.equal(c.events.length, 1);
      assert.deepEqual(c.events[0], { resource: 'program', type: 'create', data: { id: 7 } });
      c.assertOpenOnce();
      // onError may or may not fire (server-side destroy() can surface as
      // either a clean EOF or a network error on the fetch side). We don't
      // assert on it — we just require no phantom event.
    }
  );
});

test('close() mid-body: no further onEvent fires after close', async () => {
  // Stream one event, pause, stream another after a delay. The test calls
  // close() during the pause, so the second event must never arrive.
  await withServer(
    (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[\n{"resource":"program","type":"create","data":{"id":100}},\n');
      // Hold the connection open. If close() works, the client aborts before
      // we get here; if it doesn't, the test will see a second event.
      const timer = setTimeout(() => {
        res.write('{"resource":"program","type":"update","data":{"id":200}}\n]');
        res.end();
      }, 300);
      // Clean up our own timer if the socket goes away (aborted fetch).
      res.on('close', () => clearTimeout(timer));
    },
    async (baseUrl) => {
      const c = makeCollector();
      const client = new HttpMirakurunClient(baseUrl);
      const stream = client.eventsStream(c.handlers);
      await waitUntil(() => c.events.length >= 1, 2000);
      assert.equal(c.events.length, 1);

      // Close mid-stream and wait longer than the server's scheduled write.
      stream.close();
      await new Promise((r) => setTimeout(r, 400));

      assert.equal(c.events.length, 1, 'no events should fire after close()');
      // close() sets `closed = true` *before* abort, so onError must not fire
      // from the AbortError path.
      assert.equal(c.errors.length, 0, 'close() must not surface as an error');
      c.assertOpenOnce();
    }
  );
});

// The local HTTP servers are torn down per-test, but Node's test runner
// occasionally keeps a lingering handle alive. Force-exit after the suite
// finishes so CI doesn't hang.
after(() => {
  setTimeout(() => process.exit(0), 200).unref();
});
