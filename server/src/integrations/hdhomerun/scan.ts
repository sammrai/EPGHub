// LAN scanner — probes the local network for two shapes of IPTV endpoint:
//   Mirakurun (kind='mirakurun', REST + SSE on :40772)
//   generic m3u (kind='iptv', /api/iptv/channel.m3u8 on :8888 — the
//     common IPTV-proxy convention; EPGStation ships this by default
//     but we don't special-case the provider, only the URL shape)
//
// Scope stays modest: server's own LAN interfaces (private ranges only) +
// optional extra /24 prefixes supplied by the caller (from existing device
// URLs or a client-supplied hint). No /24 sweep unless a prefix is known.

import os from 'node:os';

import type { HdhomerunDiscover } from './discover.ts';
import { parseDiscover } from './discover.ts';

const PROBE_TIMEOUT_MS = 800;
const MAX_CONCURRENCY = 40;

export interface ScannedDevice {
  host: string;
  port: number;
  /** Kind we should register this as. Drives which sync pipeline runs. */
  kind: 'mirakurun' | 'iptv';
  /** URL to persist as channel_sources.url. */
  url: string;
  /** Discovered XMLTV URL (iptv only). Null for mirakurun / when unknown. */
  xmltvUrl: string | null;
  /** Used for logging / dedup. */
  discoverUrl: string;
  friendlyName: string | null;
  model: string | null;
  tunerCount: number | null;
  /** Provider family label, e.g. "Mirakurun" or "EPGStation". */
  label: string;
}

interface RawHit {
  kind: 'mirakurun' | 'iptv';
  url: string;
  xmltvUrl: string | null;
  friendlyName: string | null;
  model: string | null;
  tunerCount: number | null;
}

interface ProbeSpec {
  port: number;
  label: string;
  probe: (host: string, port: number, signal: AbortSignal) => Promise<RawHit | null>;
}

// -----------------------------------------------------------------
// Mirakurun: /api/version returns {current, latest}, /api/iptv/discover.json
// returns HDHomeRun metadata (used for FriendlyName / TunerCount only —
// we register the base URL, not the iptv m3u path, because Mirakurun's
// lineup is JSON not m3u and the existing syncMirakurun() REST pipeline
// handles channels via /api/services).
// -----------------------------------------------------------------
async function probeMirakurun(host: string, port: number, signal: AbortSignal): Promise<RawHit | null> {
  const verUrl = `http://${host}:${port}/api/version`;
  let version: string | null = null;
  try {
    const res = await fetch(verUrl, { signal });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return null;
    const cur = (body as Record<string, unknown>).current;
    if (typeof cur !== 'string') return null;
    version = cur;
  } catch {
    return null;
  }

  // Optional enrichment from discover.json — nice but not required.
  let discover: HdhomerunDiscover | null = null;
  try {
    const dRes = await fetch(`http://${host}:${port}/api/iptv/discover.json`, { signal });
    if (dRes.ok) discover = parseDiscover(await dRes.text());
  } catch { /* ignore */ }

  return {
    kind: 'mirakurun',
    url: `http://${host}:${port}`,
    xmltvUrl: null,
    friendlyName: discover?.friendlyName ?? 'Mirakurun',
    model: discover?.modelNumber ?? discover?.modelName ?? `Mirakurun ${version}`,
    tunerCount: discover?.tunerCount ?? null,
  };
}

// Known (port, path) combos that commonly serve an IPTV m3u playlist.
// Every entry is treated identically by the scanner — the probe just GETs
// the URL and accepts it if the body starts with #EXTM3U. No per-entry
// branching or provider-specific labelling; add a row to extend support.
// `xmltvPath` (optional) is a sibling-file convention that happens to hold
// the XMLTV guide for the same port; probe advertises it when present so
// the UI can one-click-add, but it's never required.
interface IptvCandidate {
  port: number;
  path: string;
  xmltvPath: string | null;
}

const IPTV_CANDIDATES: IptvCandidate[] = [
  {
    port: 8888,
    path: '/api/iptv/channel.m3u8?isHalfWidth=true&mode=1',
    xmltvPath: '/api/iptv/epg.xml?isHalfWidth=true&days=3',
  },
];

async function probeIptvM3u(
  host: string,
  cand: IptvCandidate,
  signal: AbortSignal
): Promise<RawHit | null> {
  const m3uUrl = `http://${host}:${cand.port}${cand.path}`;
  try {
    const res = await fetch(m3uUrl, { signal });
    if (!res.ok) return null;
    const body = await res.text();
    if (!body.startsWith('#EXTM3U')) return null;
  } catch {
    return null;
  }
  return {
    kind: 'iptv',
    url: m3uUrl,
    xmltvUrl: cand.xmltvPath ? `http://${host}:${cand.port}${cand.xmltvPath}` : null,
    friendlyName: null,
    model: null,
    tunerCount: null,
  };
}

const CANDIDATES: ProbeSpec[] = [
  { port: 40772, label: 'Mirakurun', probe: probeMirakurun },
  ...IPTV_CANDIDATES.map((c) => ({
    port: c.port,
    label: 'IPTV',
    probe: (host: string, _port: number, signal: AbortSignal) => probeIptvM3u(host, c, signal),
  })),
];

function localLanPrefixes(): string[] {
  const nets = os.networkInterfaces();
  const prefixes = new Set<string>();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const addr = iface.address;
      // Include real LAN prefixes; skip the Docker bridge (172.17.*) since
      // it's almost always a dead end for IPTV discovery.
      if (addr.startsWith('10.') || addr.startsWith('192.168.')) {
        const parts = addr.split('.');
        prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      } else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(addr) && !addr.startsWith('172.17.')) {
        const parts = addr.split('.');
        prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  }
  return Array.from(prefixes);
}

export function extractPrivatePrefix(hostOrUrl: string): string | null {
  if (!hostOrUrl) return null;
  let host = hostOrUrl.trim();
  if (/^https?:\/\//i.test(host)) {
    try { host = new URL(host).hostname; } catch { return null; }
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [, a, b, c] = m.map((x) => Number(x));
  if (a === 10) return `${a}.${b}.${c}`;
  if (a === 192 && b === 168) return `${a}.${b}.${c}`;
  if (a === 172 && b >= 16 && b <= 31 && b !== 17) return `${a}.${b}.${c}`;
  return null;
}

async function pool<T, U>(items: T[], limit: number, fn: (t: T) => Promise<U>): Promise<U[]> {
  const out: U[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface ScanOptions {
  hostRange?: { from: number; to: number };
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  onDevice?: (dev: ScannedDevice) => void;
  signal?: AbortSignal;
  /** Extra /24 prefixes ("X.Y.Z") to scan on top of the server's own LAN. */
  extraPrefixes?: string[];
}

export async function scanLocalNetwork(opts: ScanOptions = {}): Promise<ScannedDevice[]> {
  const auto = localLanPrefixes();
  const extra = (opts.extraPrefixes ?? [])
    .map((p) => p.trim())
    .filter((p) => /^\d+\.\d+\.\d+$/.test(p));
  const prefixes = Array.from(new Set([...auto, ...extra]));
  if (prefixes.length === 0) return [];

  const from = opts.hostRange?.from ?? 1;
  const to = opts.hostRange?.to ?? 254;
  const timeout = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  const jobs: Array<{ host: string; spec: ProbeSpec }> = [];
  for (const prefix of prefixes) {
    for (let n = from; n <= to; n++) {
      const host = `${prefix}.${n}`;
      for (const spec of CANDIDATES) jobs.push({ host, spec });
    }
  }

  const total = jobs.length;
  let done = 0;
  const seen = new Set<string>();
  const out: ScannedDevice[] = [];

  await pool(jobs, MAX_CONCURRENCY, async (j) => {
    if (opts.signal?.aborted) return;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const hit = await j.spec.probe(j.host, j.spec.port, ctrl.signal);
      if (hit) {
        // Dedupe by the *device URL* (not host:port) so the same logical
        // device only surfaces once per scan regardless of probe order.
        if (!seen.has(hit.url)) {
          seen.add(hit.url);
          const dev: ScannedDevice = {
            host: j.host,
            port: j.spec.port,
            label: j.spec.label,
            discoverUrl: `http://${j.host}:${j.spec.port}/api/version`,
            ...hit,
          };
          out.push(dev);
          opts.onDevice?.(dev);
        }
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      done++;
      opts.onProgress?.(done, total);
    }
  });

  return out;
}
