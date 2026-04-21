import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/epghub';
import type {
  ApiChannel,
  ApiNowRecording,
  ApiProgram,
  ApiRecording,
  ApiRule,
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

// 複数放送日をまとめて取得するフック。無限スクロール用に baseDate から
// +0..+daysLoaded-1 の日付を並列 fetch し結合する。dates 配列は参照同一性
// で deps 扱いしたいので内部で join-key を作って安定化。
export function useScheduleRange(dates: readonly string[]): Resource<ApiProgram[]> {
  const key = dates.join(',');
  return useResource<ApiProgram[]>(async () => {
    const all = await Promise.all(
      dates.map((d) => api.schedule.list({ date: d }))
    );
    return all.flat();
  }, [key]);
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

async function fetchCatalog(): Promise<Record<string, ApiTvdbEntry>> {
  const res = await fetch('/api/tvdb', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /tvdb → ${res.status}`);
  return res.json() as Promise<Record<string, ApiTvdbEntry>>;
}
