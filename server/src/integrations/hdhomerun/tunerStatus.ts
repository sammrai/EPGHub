// HDHomeRun per-tuner status — GET {base}/tuner{N}/status.
// Standard response (on a real HDHomeRun / Mirakurun-emulated device):
//   { "Resource": "tuner0", "VctNumber": "...", "VctName": "...",
//     "Frequency": 605028615, "SignalStrengthPercent": 60,
//     "SignalQualityPercent": 100, "SymbolQualityPercent": 100,
//     "TargetIP": "...", "NetworkRate": ... }
// Absent / idle tuners tend to return 204 or an object with empty fields.
// Mirakurun's emulation returns zeros for signal fields (it doesn't proxy
// physical radio measurements) — that's fine, the "in use" signal is still
// carried by VctName / Resource fields.

import { deriveDiscoverUrl } from './discover.ts';

export interface HdhomerunTunerStatus {
  tunerIdx: number;
  vctName: string | null;   // channel display name when active
  vctNumber: string | null; // channel number when active
  targetIp: string | null;  // client pulling the stream, if any
  /** True when any of the activity indicators are populated. */
  inUse: boolean;
}

const TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function pickString(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

// Derive the tuner{N}/status URL from the lineup URL using the same
// base-URL derivation used for discover.json.
function tunerStatusUrl(lineupUrl: string, n: number): string {
  const discover = new URL(deriveDiscoverUrl(lineupUrl));
  // deriveDiscoverUrl lands on "…/discover.json" — strip that filename.
  discover.pathname = discover.pathname.replace(/[^/]+$/, '');
  return new URL(`tuner${n}/status`, discover).toString();
}

export async function fetchTunerStatus(
  lineupUrl: string,
  tunerIdx: number
): Promise<HdhomerunTunerStatus | null> {
  try {
    const text = await fetchWithTimeout(tunerStatusUrl(lineupUrl, tunerIdx));
    if (!text.trim()) {
      return { tunerIdx, vctName: null, vctNumber: null, targetIp: null, inUse: false };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return null;
    }
    if (!doc || typeof doc !== 'object') return null;
    const o = doc as Record<string, unknown>;
    const vctName = pickString(o, 'VctName', 'vctName');
    const vctNumber = pickString(o, 'VctNumber', 'vctNumber');
    const targetIp = pickString(o, 'TargetIP', 'targetIp', 'TargetIp');
    const inUse = !!(vctName || vctNumber || targetIp);
    return { tunerIdx, vctName, vctNumber, targetIp, inUse };
  } catch {
    return null;
  }
}

export async function fetchAllTunerStatuses(
  lineupUrl: string,
  tunerCount: number
): Promise<HdhomerunTunerStatus[]> {
  if (tunerCount <= 0) return [];
  const results = await Promise.all(
    Array.from({ length: tunerCount }, (_, i) => fetchTunerStatus(lineupUrl, i))
  );
  return results.filter((r): r is HdhomerunTunerStatus => r !== null);
}
