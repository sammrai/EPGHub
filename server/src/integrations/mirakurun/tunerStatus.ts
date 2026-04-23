// Mirakurun per-tuner status — GET {base}/api/tuners.
// Mirakurun's HDHomeRun shim doesn't expose /tuner{N}/status, so the
// /tuners/live path uses this richer native endpoint instead. The shape is
// mapped back to HdhomerunTunerStatus so the router can keep one response
// type regardless of which upstream answered.

import type { HdhomerunTunerStatus } from '../hdhomerun/tunerStatus.ts';

const TIMEOUT_MS = 5_000;

interface MirakurunTunerUser {
  id?: string;
  streamSetting?: {
    channel?: { name?: string; channel?: string };
  };
}

interface MirakurunTuner {
  index?: number;
  users?: MirakurunTunerUser[];
  isUsing?: boolean;
}

function pickIp(id: string | undefined): string | null {
  if (!id) return null;
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/.exec(id);
  if (m) return m[1];
  // Non-IP ids (e.g. "Mirakurun:getEPG()") are internal consumers — surface
  // the raw id so the operator can tell the difference at a glance.
  return id;
}

export async function fetchMirakurunTunerStatuses(baseUrl: string): Promise<HdhomerunTunerStatus[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/tuners`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const doc: unknown = await res.json();
    if (!Array.isArray(doc)) return [];
    return (doc as MirakurunTuner[]).map((t, i) => {
      const user = Array.isArray(t.users) && t.users.length > 0 ? t.users[0] : null;
      const ch = user?.streamSetting?.channel;
      return {
        tunerIdx: typeof t.index === 'number' ? t.index : i,
        inUse: !!t.isUsing,
        vctName: ch?.name ?? null,
        vctNumber: ch?.channel ?? null,
        targetIp: pickIp(user?.id),
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
