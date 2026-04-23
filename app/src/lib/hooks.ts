import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/epghub';
import type {
  ApiAdminSettings,
  ApiChannel,
  ApiNowRecording,
  ApiProgram,
  ApiRecording,
  ApiRule,
  ApiSearchResult,
  ApiSystemStatus,
  ApiTunerState,
  ApiTvdbEntry,
} from '../api/epghub';

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

function useResource<T>(load: () => Promise<T>, deps: ReadonlyArray<unknown> = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const value = await load();
      setData(value);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}

export const useSchedule     = (date?: string) =>
  useResource<ApiProgram[]>(() => api.schedule.list(date ? { date } : undefined), [date]);

// 放送日ごとに個別 fetch し、到着した順に state を更新して結合する。
// 無限スクロールで dates が伸びたときは、既にロード済みの日付を再取得せず、
// 新しく増えた分だけ投げる。初回表示時も 1 日目が返った瞬間に描画できるので、
// 7 日ぶん揃うまで待たされない。
export function useScheduleRange(
  dates: readonly string[],
): Resource<ApiProgram[]> & { exhausted: boolean; loadedDays: number } {
  const key = dates.join(',');
  const [byDate, setByDate] = useState<Map<string, ApiProgram[]>>(new Map());
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // Tracks fetches in-flight so we don't fire duplicate requests for the
  // same date when `dates` mutates (e.g. user scrolls and dates is extended).
  const inFlight = useRef<Set<string>>(new Set());

  const run = useCallback(async (targets: readonly string[], reset: boolean) => {
    if (reset) {
      inFlight.current.clear();
      setByDate(new Map());
    }
    const fresh = targets.filter(
      (d) => !inFlight.current.has(d) && !(byDate.has(d) && !reset),
    );
    if (fresh.length === 0) {
      setLoading(false);
      return;
    }
    for (const d of fresh) inFlight.current.add(d);
    setLoading(true);
    await Promise.all(
      fresh.map(async (d) => {
        try {
          const progs = await api.schedule.list({ date: d });
          setByDate((prev) => {
            const next = new Map(prev);
            next.set(d, progs);
            return next;
          });
        } catch (e) {
          setError(e as Error);
        } finally {
          inFlight.current.delete(d);
        }
      }),
    );
    if (inFlight.current.size === 0) setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setError(null);
    void run(dates, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const data = useMemo<ApiProgram[] | null>(() => {
    // Keep the initial-loading sentinel (`null`) until the very first day's
    // fetch lands. Consumers gate the first paint on `data == null &&
    // loading` — flipping to `[]` too early would show an empty grid.
    if (byDate.size === 0) return null;
    const out: ApiProgram[] = [];
    for (const d of dates) {
      const got = byDate.get(d);
      if (got) out.push(...got);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, byDate]);

  const refresh = useCallback(async () => {
    setError(null);
    await run(dates, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Signals that the currently-last requested date returned zero programs
  // — the server ran out of future EPG. Consumers use this to stop the
  // infinite-scroll loader: there's nothing beyond to load.
  const exhausted = useMemo(() => {
    if (dates.length === 0) return false;
    const last = dates[dates.length - 1];
    const got = byDate.get(last);
    return got != null && got.length === 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, byDate]);

  // Length of the leading prefix of `dates` that is either not yet loaded
  // OR loaded with at least one program. Used by the grid/timeline as the
  // effective rendering bound so trailing empty days past the broadcaster's
  // EPG horizon don't show up as blank time slots.
  const loadedDays = useMemo(() => {
    let n = 0;
    for (const d of dates) {
      const got = byDate.get(d);
      if (got && got.length === 0) break;
      n++;
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, byDate]);

  return { data, error, loading, refresh, exhausted, loadedDays };
}
// Unified post-R0 recording list. Covers the full lifecycle — consumers
// filter client-side by state (scheduled/recording/encoding for the
// Reserves view; ready for the Library view).
export const useRecordings  = () => useResource<ApiRecording[]>(() => api.recordings.list());
export const useRules       = () => useResource<ApiRule[]>(() => api.rules.list());
export const useTvdbCatalog = () => useResource<Record<string, ApiTvdbEntry>>(fetchCatalog);
export const useTuners      = () => useResource<ApiTunerState[]>(() => api.tuners.list());
export const useNowRecording = () => useResource<ApiNowRecording[]>(() => api.tuners.nowRecording());
export const useSystem      = () => useResource<ApiSystemStatus>(() => api.system.status());
export const useChannelsApi = () => useResource<ApiChannel[]>(() => api.channels.list());
export const useAdminSettings = () => useResource<ApiAdminSettings>(() => api.admin.settings.get());

// Debounced global search hook. query を入力中はリクエストを 180ms まとめて
// 1 本に絞り、AbortController で途中打ち切る。空文字のときは即時 empty。
export interface SearchState {
  data: ApiSearchResult | null;
  loading: boolean;
  error: Error | null;
}

const EMPTY_SEARCH: ApiSearchResult = {
  q: '',
  total: 0,
  programs: [],
  series: [],
  channels: [],
  rules: [],
  recordings: [],
};

export function useSearch(query: string): SearchState {
  const [state, setState] = useState<SearchState>({ data: null, loading: false, error: null });
  const reqSeq = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setState({ data: EMPTY_SEARCH, loading: false, error: null });
      return;
    }
    const ctrl = new AbortController();
    const mySeq = ++reqSeq.current;
    const timer = window.setTimeout(() => {
      setState((s) => ({ data: s.data, loading: true, error: null }));
      api.search
        .query(trimmed, { signal: ctrl.signal })
        .then((res) => {
          if (mySeq !== reqSeq.current) return;
          setState({ data: res, loading: false, error: null });
        })
        .catch((err: Error) => {
          if (ctrl.signal.aborted) return;
          if (mySeq !== reqSeq.current) return;
          setState({ data: null, loading: false, error: err });
        });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  return state;
}

async function fetchCatalog(): Promise<Record<string, ApiTvdbEntry>> {
  const res = await fetch('/api/tvdb', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /tvdb → ${res.status}`);
  return res.json() as Promise<Record<string, ApiTvdbEntry>>;
}
