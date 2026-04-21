import type { MrProgram, MrService, MrTunerDevice } from './types.ts';

// Mirakurun Event = one frame of /events/stream, wrapping a create/update/
// remove/redefine for either a program or a service. See:
// https://mirakurun.0sr.in/docs/rest-api/v2.0/#/events
export interface MrEvent {
  resource: 'program' | 'service' | 'tuner';
  type: 'create' | 'update' | 'remove' | 'redefine';
  data: unknown;
}

/** Subscriber handle returned by {@link MirakurunClient.eventsStream}. */
export interface MrEventStream {
  /** Stop the SSE connection. Idempotent. */
  close(): void;
}

export interface MirakurunClient {
  services(): Promise<MrService[]>;
  programs(): Promise<MrProgram[]>;
  tuners(): Promise<MrTunerDevice[]>;
  /**
   * Subscribe to /events/stream. Mirakurun streams a JSON array framed as
   * `[\n{…},\n{…},\n…]` rather than well-formed SSE, so we do line-buffered
   * parsing on the raw fetch body. Each parsed frame is delivered to
   * `onEvent`. `onError` fires on connection errors (caller reconnects).
   * The returned handle's `close()` aborts the underlying fetch.
   *
   * Docs: https://mirakurun.0sr.in/docs/rest-api/v2.0/#/events/getEventsStream
   */
  eventsStream(handlers: {
    onEvent: (ev: MrEvent) => void;
    onError?: (err: unknown) => void;
    onOpen?: () => void;
  }): MrEventStream;
}

const DEFAULT_TIMEOUT_MS = 20000;

export class HttpMirakurunClient implements MirakurunClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`mirakurun ${path} → ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  services(): Promise<MrService[]> {
    return this.get<MrService[]>('/api/services');
  }

  programs(): Promise<MrProgram[]> {
    return this.get<MrProgram[]>('/api/programs');
  }

  tuners(): Promise<MrTunerDevice[]> {
    return this.get<MrTunerDevice[]>('/api/tuners');
  }

  eventsStream(handlers: {
    onEvent: (ev: MrEvent) => void;
    onError?: (err: unknown) => void;
    onOpen?: () => void;
  }): MrEventStream {
    // Mirakurun's SSE endpoint is under /api/events/stream (not /events/stream).
    // The wrong path produced 404 → endless reconnect loop in logs.
    const url = `${this.baseUrl}/api/events/stream`;
    const ctrl = new AbortController();
    let closed = false;

    void (async () => {
      try {
        const res = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`mirakurun events ${res.status}`);
        }
        handlers.onOpen?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        // Framing (from EPGStation's EPGUpdateManageModel): the response
        // starts with `[\n`, each event frame ends with `},\n`, the last one
        // is followed by `]`. We accumulate until we see a `},\n` boundary,
        // then parse events up to that point.
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Strip the leading `[\n` once.
          if (buf.startsWith('[\n')) buf = buf.slice(2);
          // Strip any frame-separator junk at the head. Normally this is
          // cleaned up after each parse below, but if a frame ends exactly
          // at a chunk boundary, the trailing `,\n` can show up in buf only
          // after the next read — and must be skipped before we try to find
          // the next frame, else JSON.parse chokes on a leading `,`.
          while (buf.length && (buf[0] === ',' || buf[0] === '\n' || buf[0] === ']' || buf[0] === ' ')) {
            buf = buf.slice(1);
          }
          // Parse as many full `{...},\n` (or `{...}\n]`) frames as we have.
          while (true) {
            // Find the end of one JSON object. We use a brace counter so
            // nested objects don't confuse us.
            const end = findFrameEnd(buf);
            if (end < 0) break;
            const frame = buf.slice(0, end);
            buf = buf.slice(end);
            // Skip the trailing `,\n` or `\n]` etc.
            while (buf.length && (buf[0] === ',' || buf[0] === '\n' || buf[0] === ']' || buf[0] === ' ')) {
              buf = buf.slice(1);
            }
            try {
              const parsed = JSON.parse(frame) as MrEvent;
              handlers.onEvent(parsed);
            } catch (err) {
              handlers.onError?.(err);
            }
          }
        }
      } catch (err) {
        if (!closed) handlers.onError?.(err);
      }
    })();

    return {
      close(): void {
        if (closed) return;
        closed = true;
        try { ctrl.abort(); } catch { /* ignore */ }
      },
    };
  }
}

// Scan `buf` from the start; return the index *after* the first complete
// JSON object, or -1 if no complete object is present. Assumes the first
// non-whitespace character is `{`.
function findFrameEnd(buf: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  let started = false;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return i + 1;
    }
  }
  return -1;
}

// Returns a live client when MIRAKURUN_URL is set, otherwise null. Callers
// should fall back to Fixture-backed services.
export function createMirakurunClient(): MirakurunClient | null {
  const url = process.env.MIRAKURUN_URL;
  if (!url) return null;
  return new HttpMirakurunClient(url.replace(/\/$/, ''));
}
