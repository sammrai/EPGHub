// HDHomeRun HTTP discovery — GET {base}/discover.json.
// Mirakurun (`/api/iptv`), tvheadend, Channels, and most commercial IPTV
// providers implement this protocol so we can get device metadata
// (model, tuner count, unique device id) without vendor-specific code.
// Docs: https://info.hdhomerun.com/info/http_api

// Resolve the HDHomeRun-style lineup URL for a registered channel_sources
// row. For kind='iptv' the row's URL already *is* the lineup URL (that's how
// the user registered it). For kind='mirakurun' the user registered the base
// URL (e.g. http://host:40772), but Mirakurun's HDHomeRun emulation lives at
// /api/iptv under that, so we append it transparently. Centralizing this
// means sync + /tuners/live + any future probe share one rule.
export function hdhomerunLineupUrl(kind: string, url: string): string {
  if (kind !== 'mirakurun') return url;
  try {
    const u = new URL(url);
    if (/\/api\/iptv\/?$/.test(u.pathname)) return url;
    u.pathname = u.pathname.replace(/\/+$/, '') + '/api/iptv';
    return u.toString();
  } catch {
    return url;
  }
}

export interface HdhomerunDiscover {
  friendlyName: string | null;
  manufacturer: string | null;
  modelName: string | null;
  modelNumber: string | null;
  firmwareVersion: string | null;
  deviceId: string | null;
  tunerCount: number | null;
  lineupUrl: string | null;
  baseUrl: string | null;
}

const FETCH_TIMEOUT_MS = 8_000;

// Derive the HDHomeRun discover URL from an m3u / lineup URL.
// e.g.  http://h:40772/api/iptv         → http://h:40772/api/iptv/discover.json
//       http://h:40772/api/iptv/        → http://h:40772/api/iptv/discover.json
//       http://h:80/iptv/playlist.m3u   → http://h:80/iptv/discover.json
export function deriveDiscoverUrl(lineupUrl: string): string {
  const u = new URL(lineupUrl);
  u.search = '';
  u.hash = '';
  const lastSlash = u.pathname.lastIndexOf('/');
  if (lastSlash >= 0) {
    const tail = u.pathname.slice(lastSlash + 1);
    // Strip filename-with-extension (e.g. playlist.m3u, tvg.m3u8) so the
    // discover lookup targets the provider's "directory", not a specific file.
    if (/\./.test(tail)) {
      u.pathname = u.pathname.slice(0, lastSlash + 1);
    } else if (!u.pathname.endsWith('/')) {
      u.pathname += '/';
    }
  }
  return new URL('discover.json', u).toString();
}

async function fetchWithTimeout(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function pickInt(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number.parseInt(v, 10);
  }
  return null;
}

// Tolerant parser — the HDHomeRun JSON is well-known but field casing and
// optionality varies across reimplementations. Unknown fields → null.
export function parseDiscover(json: string): HdhomerunDiscover {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return {
      friendlyName: null, manufacturer: null, modelName: null, modelNumber: null,
      firmwareVersion: null, deviceId: null, tunerCount: null, lineupUrl: null, baseUrl: null,
    };
  }
  if (!doc || typeof doc !== 'object') {
    return {
      friendlyName: null, manufacturer: null, modelName: null, modelNumber: null,
      firmwareVersion: null, deviceId: null, tunerCount: null, lineupUrl: null, baseUrl: null,
    };
  }
  const o = doc as Record<string, unknown>;
  return {
    friendlyName:    pickString(o, 'FriendlyName', 'friendlyName'),
    manufacturer:    pickString(o, 'Manufacturer', 'manufacturer'),
    modelName:       pickString(o, 'ModelName', 'modelName'),
    modelNumber:     pickString(o, 'ModelNumber', 'modelNumber'),
    firmwareVersion: pickString(o, 'FirmwareVersion', 'firmwareVersion'),
    deviceId:        pickString(o, 'DeviceID', 'deviceId'),
    tunerCount:      pickInt(o,    'TunerCount', 'tunerCount'),
    lineupUrl:       pickString(o, 'LineupURL', 'lineupUrl'),
    baseUrl:         pickString(o, 'BaseURL', 'baseUrl'),
  };
}

export async function fetchHdhomerunDiscover(lineupUrl: string): Promise<HdhomerunDiscover | null> {
  const discoverUrl = deriveDiscoverUrl(lineupUrl);
  try {
    const text = await fetchWithTimeout(discoverUrl);
    return parseDiscover(text);
  } catch {
    // Provider doesn't implement HDHomeRun — that's fine, iptv still works
    // with m3u+XMLTV alone. Caller just sees null and keeps metadata empty.
    return null;
  }
}
