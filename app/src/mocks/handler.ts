// Route matcher for the GitHub Pages mock deploy. Each entry handles one
// HTTP method + path prefix and returns the canned payload from data.ts.
// Matches the API surface of app/src/api/epghub.ts — only GET endpoints
// and a best-effort stub for common mutations so the UI doesn't explode
// when a button is clicked. Pages is static so mutations are ephemeral.
import {
  CHANNELS,
  RANKINGS,
  RULES,
  SYSTEM,
  TUNERS,
  TUNER_ALLOCATION,
  TVDB_CATALOG,
  defaultToday,
  nowRecording,
  programsForDate,
  recordingsList,
  searchPrograms,
} from './data';

type Body = unknown;

function ok(body: Body, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

// In-memory recording mutations. They reset on reload (good enough for a
// static demo, where any state is expected to be throw-away).
let ephemeralRecordings = recordingsList(defaultToday());

function handleRecordings(method: string, url: URL): Response | null {
  const tail = url.pathname.replace(/^\/api\/recordings/, '');
  if (tail === '' || tail === '/') {
    if (method === 'GET') return ok(ephemeralRecordings);
    if (method === 'POST') {
      const rec = { id: `rec-${Date.now()}`, state: 'scheduled', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as typeof ephemeralRecordings[number];
      ephemeralRecordings = [...ephemeralRecordings, rec];
      return ok(rec);
    }
  }
  const idMatch = tail.match(/^\/([^/]+)(\/[^/]+)?$/);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    const sub = idMatch[2];
    if (sub === '/drops') return ok({ recordingId: id, logs: [], summary: { packets: 0, drops: 0, scrambled: 0 } });
    if (sub === '/stop' && method === 'POST') return noContent();
    if (sub === '/encode' && method === 'POST') return noContent();
    if (method === 'GET') {
      const hit = ephemeralRecordings.find((r) => r.id === id);
      return hit ? ok(hit) : new Response(null, { status: 404 });
    }
    if (method === 'PATCH') {
      ephemeralRecordings = ephemeralRecordings.map((r) => (r.id === id ? { ...r, ...{} } : r));
      return ok(ephemeralRecordings.find((r) => r.id === id) ?? null);
    }
    if (method === 'DELETE') {
      ephemeralRecordings = ephemeralRecordings.filter((r) => r.id !== id);
      return noContent();
    }
  }
  return null;
}

export function handleMockRequest(req: Request): Response | null {
  const url = new URL(req.url, window.location.origin);
  if (!url.pathname.startsWith('/api/')) return null;

  const method = req.method.toUpperCase();
  const today = defaultToday();

  switch (url.pathname) {
    case '/api/channels':
      return method === 'GET' ? ok(CHANNELS) : null;
    case '/api/schedule': {
      const date = url.searchParams.get('date') ?? today;
      return method === 'GET' ? ok(programsForDate(date)) : null;
    }
    case '/api/rules':
      return method === 'GET' ? ok(RULES) : null;
    case '/api/tuners':
      return method === 'GET' ? ok(TUNERS) : null;
    case '/api/tuners/allocation':
      return method === 'GET' ? ok(TUNER_ALLOCATION) : null;
    case '/api/now-recording':
      return method === 'GET' ? ok(nowRecording(today)) : null;
    case '/api/system':
      return method === 'GET' ? ok(SYSTEM) : null;
    case '/api/rankings':
      return method === 'GET' ? ok(RANKINGS) : null;
    case '/api/search': {
      const q = url.searchParams.get('q') ?? '';
      return method === 'GET' ? ok(searchPrograms(q, today)) : null;
    }
    case '/api/admin/refresh-epg':
      return method === 'POST' ? ok({ upserted: 34, resolved: 0, missed: 0 }) : null;
    case '/api/admin/expand-rules':
      return method === 'POST' ? ok({ matched: 0, created: 0, duplicate: 0, tunerFull: 0 }) : null;
    case '/api/admin/channel-sources':
      return method === 'GET' ? ok([]) : method === 'POST' ? ok({ id: 1 }) : null;
    case '/api/admin/gpu/status':
      return method === 'GET' ? ok({ enabled: false, preferred: null, available: [] }) : null;
    case '/api/admin/gpu/probe':
      return method === 'POST' ? ok({ available: [], chosen: null }) : null;
  }

  if (url.pathname.startsWith('/api/recordings')) {
    const hit = handleRecordings(method, url);
    if (hit) return hit;
  }

  if (url.pathname.startsWith('/api/tvdb/search')) {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const hits = TVDB_CATALOG.filter((e) =>
      e.title.toLowerCase().includes(q) || (e.titleEn ?? '').toLowerCase().includes(q)
    );
    return ok(hits);
  }
  const tvdbIdMatch = url.pathname.match(/^\/api\/tvdb\/(\d+)(\/episodes)?$/);
  if (tvdbIdMatch) {
    const id = Number(tvdbIdMatch[1]);
    const hit = TVDB_CATALOG.find((e) => e.id === id);
    if (tvdbIdMatch[2]) return ok([]);
    return hit ? ok(hit) : new Response(null, { status: 404 });
  }

  if (url.pathname.startsWith('/api/programs/')) {
    // Program detail / tvdb link patches — just no-op so modals can open.
    if (method === 'GET') {
      const id = decodeURIComponent(url.pathname.replace('/api/programs/', ''));
      const prog = programsForDate(today).find((p) => p.id === id);
      return prog ? ok(prog) : new Response(null, { status: 404 });
    }
    return method === 'DELETE' ? noContent() : ok({});
  }

  return new Response(JSON.stringify({ code: 'mock_not_implemented', path: url.pathname }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
