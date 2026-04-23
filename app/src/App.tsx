import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { Brand, Header, Sidebar } from './components/Shell';
import { GridView, Subheader } from './components/Grid';
import type { GridLayout, GridDensity, GridBcType } from './components/Grid';
import { TimelineView } from './components/Timeline';
import type { ScrubRange } from './components/Timeline';
import { AgendaView, RulesPage } from './components/Agenda';
import { ReserveModal } from './components/Modal';
import { SearchPalette } from './components/SearchPalette';
import type { SearchAction } from './components/SearchPalette';
import {
  DiscoverPage,
  LibraryPage,
  ReservesPage,
  SettingsPage,
} from './components/Pages';
import {
  useChannelsApi,
  useNowRecording,
  useRecordings,
  useRules,
  useScheduleRange,
  useSystem,
  useTuners,
  useTvdbCatalog,
} from './lib/hooks';
import {
  reservedProgramIds,
  toProgram,
  toRecording,
  toRule,
  tunersToUi,
} from './lib/adapters';
import { api, ApiError } from './api/epghub';
import type { ApiRecording, ApiUpdateRecording } from './api/epghub';
import { progId } from './lib/epg';
import { addDays, jstTodayYmd } from './lib/broadcastDay';
import { pushModalToUrl, wasOpenedInApp } from './lib/modalUrl';
import type { Channel, Program, Recording, Rule, TvdbEntry, TvdbSeries } from './data/types';

type Page = 'guide' | 'library' | 'rules' | 'reserves' | 'discover' | 'settings';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// Map a pathname to the Page key used for Sidebar active state / header label.
function pageFromPath(pathname: string): Page {
  if (pathname === '/' || pathname === '') return 'guide';
  if (pathname.startsWith('/library')) return 'library';
  if (pathname.startsWith('/rules')) return 'rules';
  if (pathname.startsWith('/reserves')) return 'reserves';
  if (pathname.startsWith('/discover')) return 'discover';
  if (pathname.startsWith('/settings')) return 'settings';
  return 'guide';
}

const PAGE_PATHS: Record<Page, string> = {
  guide: '/',
  library: '/library',
  rules: '/rules',
  reserves: '/reserves',
  discover: '/discover',
  settings: '/settings',
};

interface Toast {
  id: number;
  msg: string;
  kind: 'ok' | 'err';
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = pageFromPath(location.pathname);

  // ?date=YYYY-MM-DD — only meaningful on the guide route. Elsewhere we
  // still need *some* date to bound the schedule fetch, so we fall back
  // to today. This matches the pre-routing behaviour where every page
  // shared the same `selectedDate` piece of state.
  const urlDate = page === 'guide' ? searchParams.get('date') : null;
  const selectedDate = urlDate && YMD_RE.test(urlDate) ? urlDate : jstTodayYmd();

  const setSelectedDate = useCallback(
    (d: string) => {
      // Stay on the current route; just update ?date=. Preserve any other
      // params the user may have added (e.g. modal).
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('date', d);
          return next;
        },
        { replace: false }
      );
    },
    [setSearchParams]
  );

  // Infinite-scroll: additional broadcast-days to load past the base.
  // Resets whenever the base day changes.
  // Infinite-scroll: start with just today + tomorrow so the initial paint
  // is fast, then extend as the user scrolls toward the bottom. The
  // day-picker dropdown exposes the full week independently; this only
  // governs how much EPG data we pull in a single request.
  const [daysLoaded, setDaysLoaded] = useState<number>(2);
  useEffect(() => {
    setDaysLoaded(2);
  }, [selectedDate]);

  // Live-scroll date display (課題#13). Tracks which broadcast day the Grid
  // or Timeline is currently showing; the Subheader surfaces it as a
  // secondary chip when it differs from selectedDate. Reset whenever the
  // user picks a new base day so we don't stick at a stale value.
  const [displayedDate, setDisplayedDate] = useState<string>(selectedDate);
  useEffect(() => {
    setDisplayedDate(selectedDate);
  }, [selectedDate]);
  const dateRange = useMemo(
    () => Array.from({ length: daysLoaded }, (_, i) => addDays(selectedDate, i)),
    [selectedDate, daysLoaded]
  );
  const schedule = useScheduleRange(dateRange);
  const loadMoreDays = useCallback(() => {
    // Stop growing once the hook signals the last loaded day came back
    // empty — that's the edge of the broadcaster's EPG window (Mirakurun
    // typically exposes ~7–8 days). No artificial numeric cap; a large
    // ceiling guards against a scroll feedback loop only.
    if (schedule.exhausted) return;
    setDaysLoaded((n) => Math.min(n + 1, 60));
  }, [schedule.exhausted]);

  const recordingsR = useRecordings();
  const rulesR = useRules();
  const tvdbR = useTvdbCatalog();
  const tunersR = useTuners();
  const nowRecR = useNowRecording();
  const systemR = useSystem();
  const channelsR = useChannelsApi();

  const [layout, setLayout] = useState<GridLayout>(
    () => (localStorage.getItem('epg-layout') as GridLayout) || 'grid'
  );
  const [density] = useState<GridDensity>(
    () => (localStorage.getItem('epg-density') as GridDensity) || 'normal'
  );
  const [genreFilter, setGenreFilter] = useState<string>('all');
  const [bcType, setBcType] = useState<GridBcType>('all');
  const [selectedProg, setSelectedProg] = useState<string | null>(null);
  // scrubRange は Timeline ビュー内 (baseDate 05:00 JST 起点) の分オフセット。
  // 13*60=780 → baseDate 18:00 JST。デフォルトで放送日の夕方〜夜を映す。
  const [scrubRange, setScrubRange] = useState<ScrubRange>({ start: 13 * 60, end: 18 * 60 });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => localStorage.setItem('epg-layout', layout), [layout]);
  useEffect(() => localStorage.setItem('epg-density', density), [density]);

  const pushToast = useCallback((msg: string, kind: Toast['kind'] = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);

  // Derived, memoized data — kept as stable inputs for child components.
  const reservedProgIdSet = useMemo(
    () => reservedProgramIds(recordingsR.data ?? []),
    [recordingsR.data]
  );

  const programs = useMemo<Program[]>(() => {
    const now = new Date();
    return (schedule.data ?? []).map((p) => toProgram(p, reservedProgIdSet, now));
  }, [schedule.data, reservedProgIdSet]);

  const reservedIds = useMemo(
    () => new Set(programs.filter((p) => p.rec).map(progId)),
    [programs]
  );

  const rules = useMemo(() => (rulesR.data ?? []).map(toRule), [rulesR.data]);
  // Post-R0 unified view: one recording row covers the whole lifecycle. We
  // split into "scheduled or in-flight" (shown by the Reserves page) and
  // "ready" (shown by the Library page). Mapping to the domain Recording
  // shape via toRecording() gives both views the same field names.
  const scheduledOrLive = useMemo<ApiRecording[]>(
    () => (recordingsR.data ?? []).filter((r) => r.state !== 'ready'),
    [recordingsR.data]
  );
  const library = useMemo<Recording[]>(
    () =>
      (recordingsR.data ?? [])
        .filter((r) => r.state === 'ready')
        .map(toRecording),
    [recordingsR.data]
  );

  const channels = channelsR.data ?? [];
  const tvdbCatalog = tvdbR.data ?? {};
  const tvdbList = useMemo(() => Object.values(tvdbCatalog) as TvdbEntry[], [tvdbCatalog]);

  const tunerSummary = useMemo(() => tunersToUi(tunersR.data ?? []), [tunersR.data]);
  const storageGb = systemR.data ? systemR.data.storage.totalBytes / 1024 ** 4 : 0;
  const usedGb = systemR.data ? systemR.data.storage.usedBytes / 1024 ** 4 : 0;
  const systemForSidebar = useMemo(
    () => ({
      storage: { total: Number(storageGb.toFixed(2)), used: Number(usedGb.toFixed(2)), unit: 'TB' },
      tuners: tunerSummary,
      upcoming: systemR.data?.upcomingReserves ?? 0,
      today: systemR.data?.today ?? '',
    }),
    [storageGb, usedGb, tunerSummary, systemR.data]
  );

  const filteredPrograms = useMemo(
    () => programs.filter((p) => genreFilter === 'all' || p.genre.key === genreFilter),
    [programs, genreFilter]
  );
  const visibleChannels = useMemo(
    () => channels.filter((c) => c.enabled && (bcType === 'all' || c.type === bcType)),
    [channels, bcType]
  );

  // === API-bound actions ===
  const apiProgramId = (p: Program): string | null => {
    if (p.id) return p.id;
    const match = (schedule.data ?? []).find(
      (ap) => ap.ch === p.ch && ap.startAt.includes(`T${p.start}`)
    );
    return match?.id ?? null;
  };

  // Return the active "scheduled or in-flight" recording for this program,
  // or undefined. Used by cancel/edit flows where we want to act on the live
  // plan row regardless of state — DELETE works through scheduled→conflict,
  // POST /stop only on recording.
  const findRecordingForProgram = (p: Program) => {
    const pid = apiProgramId(p);
    if (!pid) return undefined;
    return scheduledOrLive.find((r) => r.programId === pid);
  };

  // `?modal=<programId>` は URL レベルのオーバーレイとして扱う。Guide /
  // Discover / 将来増える任意ページから開けるように、page のゲートは持たない。
  // 閉じるとき (closeModal) は history entry の state を見て、アプリ内で push
  // されたエントリなら navigate(-1)、deep link なら setSearchParams で param
  // を剥がす、と対称に動作する。
  const modalId = searchParams.get('modal');
  // Deep-link フォールバック: modalId がロード済み schedule の範囲外を指す
  // (例: 来週の番組への直リンク) と programs.find() が空振りして Modal が開か
  // ない課題があった。GET /programs/:id を単発で取りにいき、その番組だけを
  // ローカル state に保持して Modal に渡す。range 内 (programs に居る) な
  // ら fetch をスキップ。
  const [deepLinkProg, setDeepLinkProg] = useState<Program | null>(null);
  useEffect(() => {
    if (!modalId) {
      setDeepLinkProg(null);
      return;
    }
    if (programs.some((p) => progId(p) === modalId)) {
      setDeepLinkProg(null);
      return;
    }
    let cancelled = false;
    api.programs
      .get(modalId)
      .then((ap) => {
        if (cancelled) return;
        setDeepLinkProg(toProgram(ap, reservedProgIdSet, new Date()));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        console.warn('[deeplink] program fetch failed', e.message);
        setDeepLinkProg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [modalId, programs, reservedProgIdSet]);
  const modalProg = useMemo(() => {
    if (!modalId) return null;
    const found = programs.find((p) => progId(p) === modalId);
    if (found) return found;
    if (deepLinkProg && progId(deepLinkProg) === modalId) return deepLinkProg;
    return null;
  }, [modalId, programs, deepLinkProg]);

  const openModal = useCallback(
    (p: Program) => {
      setSelectedProg(progId(p));
      pushModalToUrl(setSearchParams, progId(p));
    },
    [setSearchParams],
  );

  // close は「自分で push したエントリなら navigate(-1)」「deep link なら
  // param を剥がす」を対称に切り替える。location.state.modalOpenedInApp が
  // pushModalToUrl の印。
  const closeModal = useCallback(() => {
    if (!searchParams.get('modal')) return;
    if (wasOpenedInApp(location.state)) {
      navigate(-1);
    } else {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('modal');
          return next;
        },
        { replace: true },
      );
    }
  }, [location.state, navigate, searchParams, setSearchParams]);

  const handleReserve = async (p: Program) => {
    const existing = findRecordingForProgram(p);
    try {
      if (existing) {
        await api.recordings.remove(existing.id);
        pushToast(`予約を取り消しました: ${p.title.slice(0, 20)}`);
      } else {
        const pid = apiProgramId(p);
        if (!pid) throw new Error('programId missing');
        // Omit priority/quality/keepRaw/margin* so the server fills them in
        // from admin_settings.rec.* (set from the Settings page).
        await api.recordings.create({
          programId: pid,
          source: { kind: 'once' },
          force: false,
        });
        pushToast(`予約しました: ${p.title.slice(0, 20)}`);
      }
      await recordingsR.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        pushToast(`競合: ${e.message}`, 'err');
      } else {
        pushToast(`エラー: ${(e as Error).message}`, 'err');
      }
    }
    closeModal();
  };

  const handleCreateRule = async (keyword: string, p: Program, channels?: string[]) => {
    try {
      await api.rules.create({
        name: keyword,
        keyword,
        channels: channels ?? [p.ch],
        enabled: true,
        priority: 'medium',
        quality: '1080i',
        skipReruns: true,
        kind: 'keyword',
      });
      await rulesR.refresh();
      pushToast(`ルール「${keyword}」を作成しました`);
    } catch (e) {
      pushToast(`ルール作成失敗: ${(e as Error).message}`, 'err');
    }
    closeModal();
  };

  const handleUnsubscribeSeries = async (tvdbId: number) => {
    const rule = rules.find((r) => r.kind === 'series' && r.tvdb?.id === tvdbId);
    if (!rule) {
      pushToast('対応するシリーズルールが見つかりません', 'err');
      return;
    }
    try {
      await api.rules.remove(rule.id);
      await rulesR.refresh();
      await recordingsR.refresh();
      pushToast(`シリーズ「${rule.tvdb?.title ?? rule.name}」の自動予約を解除しました`);
    } catch (e) {
      pushToast(`シリーズ解除失敗: ${(e as Error).message}`, 'err');
    }
    closeModal();
  };

  const handleCreateSeriesLink = async (tvdb: TvdbSeries, p: Program, channels?: string[]) => {
    try {
      await api.rules.create({
        name: tvdb.title,
        keyword: tvdb.title,
        channels: channels ?? [p.ch],
        enabled: true,
        priority: 'medium',
        quality: '1080i',
        skipReruns: true,
        kind: 'series',
        tvdb,
      });
      await rulesR.refresh();
      pushToast(`シリーズ「${tvdb.title}」を TVDB に紐付けました`);
    } catch (e) {
      pushToast(`シリーズ紐付け失敗: ${(e as Error).message}`, 'err');
    }
    closeModal();
  };

  const toggleRule = async (id: number) => {
    const cur = rules.find((r) => r.id === id);
    if (!cur) return;
    try {
      await api.rules.update(id, { enabled: !cur.enabled });
      await rulesR.refresh();
    } catch (e) {
      pushToast(`ルール更新失敗: ${(e as Error).message}`, 'err');
    }
  };

  const handleUpdateRule = async (
    id: number,
    patch: {
      name?: string;
      keyword?: string;
      channels?: string[];
      priority?: 'high' | 'medium' | 'low';
      quality?: string;
      skipReruns?: boolean;
      enabled?: boolean;
    }
  ) => {
    if (Object.keys(patch).length === 0) return;
    try {
      // quality is narrowed to '1080i' | '720p' in ApiRule; the modal
      // only ever emits those two values but TypeScript needs a cast.
      await api.rules.update(id, patch as Parameters<typeof api.rules.update>[1]);
      await rulesR.refresh();
      pushToast('ルールを更新しました');
    } catch (e) {
      pushToast(`ルール更新失敗: ${(e as Error).message}`, 'err');
    }
  };

  const handleDeleteRule = async (id: number) => {
    const cur = rules.find((r) => r.id === id);
    try {
      await api.rules.remove(id);
      await rulesR.refresh();
      await recordingsR.refresh();
      pushToast(`ルール「${cur?.name ?? id}」を削除しました`);
    } catch (e) {
      pushToast(`ルール削除失敗: ${(e as Error).message}`, 'err');
    }
  };

  const handleCancelReserve = async (p: Program) => {
    const existing = findRecordingForProgram(p);
    if (!existing) return;
    try {
      await api.recordings.remove(existing.id);
      await Promise.all([recordingsR.refresh(), nowRecR.refresh()]);
      pushToast(`予約を取り消しました: ${p.title.slice(0, 20)}`);
    } catch (e) {
      pushToast(`予約取消失敗: ${(e as Error).message}`, 'err');
    }
    // Close the modal so a re-open triggers a fresh lookup against the
    // just-refreshed recordings list (否則 stale modalProg が残って "reserved"
    // 判定が遅れ、同じ番組を開き直したときに古いボタンが表示される). 課題#2.
    closeModal();
  };

  const handleUpdateReserve = async (
    id: string,
    patch: ApiUpdateRecording
  ) => {
    try {
      await api.recordings.update(id, patch);
      await recordingsR.refresh();
      pushToast('予約を更新しました');
    } catch (e) {
      pushToast(`更新失敗: ${(e as Error).message}`, 'err');
    }
  };

  // Used by ReservesPage's 1s polling effect while anything is recording /
  // encoding. Single refresh against the unified /recordings endpoint now
  // that R0 merged reserves + recorded into one row. 課題#27.
  const pollRefresh = useCallback(async () => {
    await recordingsR.refresh();
  }, [recordingsR]);

  const handleStopRecording = async (recordingId: string) => {
    try {
      await api.recordings.stop(recordingId);
      // The server-side stop flow finalizes the .part file and transitions
      // the recording row to encoding/ready. Refresh recordings + now-
      // recording so the UI reflects the transition in a single tick.
      await Promise.all([recordingsR.refresh(), nowRecR.refresh()]);
      pushToast('録画を停止しました');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        pushToast('録画中ではないため停止できません', 'err');
      } else {
        pushToast(`録画停止失敗: ${(e as Error).message}`, 'err');
      }
    }
    closeModal();
  };

  const recordingIdForProgram = useCallback(
    (programId: string): string | null => {
      // Return the id only when the recording is actually live — otherwise
      // the modal's 停止 button would fire against a non-recording row and
      // get 409 back (課題#2). The DELETE path uses findRecordingForProgram
      // which is state-agnostic across scheduled/conflict.
      const hit = (recordingsR.data ?? []).find(
        (r) => r.programId === programId && r.state === 'recording'
      );
      return hit?.id ?? null;
    },
    [recordingsR.data]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K → open global search. Preventing default so Safari's
      // URL-bar shortcut doesn't eat the keystroke. "/" も最小入力フィールド
      // でないときだけサーチ起動 (input 内入力時は素通し)。
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inEditable =
        tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable;
      if (e.key === '/' && !inEditable && !searchOpen) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key === 'Escape' && modalProg) closeModal();
      if (!inEditable) {
        if (e.key === '1') setLayout('grid');
        if (e.key === '2') setLayout('timeline');
        if (e.key === '3') setLayout('agenda');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeModal, modalProg, searchOpen]);

  const counts = {
    series: rules.filter((r) => r.kind === 'series' && r.enabled).length,
    rules: rules.filter((r) => r.enabled).length,
    reserves: reservedIds.size,
    recorded: library.length,
    conflict: 0,
  };

  const recordingCount = (recordingsR.data ?? []).filter((r) => r.state === 'recording').length;

  // Only hide the Routes tree while we have *no* data yet — otherwise a
  // re-fetch (e.g. daysLoaded++ adding a new broadcast-day) would unmount
  // <GridView>, blow away its accumulated scrollTop, and remount at the
  // top (= "端までスクロールすると真っ白 + トップにリセット" bug 課題#12).
  const isInitialLoading =
    (schedule.data == null && schedule.loading) ||
    (recordingsR.data == null && recordingsR.loading) ||
    (rulesR.data == null && rulesR.loading) ||
    (tvdbR.data == null && tvdbR.loading) ||
    (tunersR.data == null && tunersR.loading) ||
    (systemR.data == null && systemR.loading) ||
    (channelsR.data == null && channelsR.loading);

  // Header/breadcrumb: on /library/:tvdbId show the series title crumb.
  const libraryIdMatch = location.pathname.match(/^\/library\/(\d+)/);
  const libraryView = libraryIdMatch ? Number(libraryIdMatch[1]) : null;
  const crumbs =
    page === 'library' && libraryView != null
      ? [
          {
            label:
              (Object.values(tvdbCatalog).find((t) => t.id === libraryView) ?? { title: '' })
                .title,
          },
        ]
      : [];

  const existingSeriesIdSet = new Set(
    rules.flatMap((r) => (r.kind === 'series' && r.tvdb ? [r.tvdb.id] : []))
  );

  // Global search の "選択" を実際の遷移に振り分ける。
  // - program → 予約モーダルを開く (deep-link 経路と同じ ?modal=<id>)
  // - series  → ライブラリのそのシリーズ絞り込みに飛ぶ
  // - channel → 番組表に戻る (BC フィルタで絞り込み)
  // - rule    → ルール管理画面へ
  // - recording → ライブラリに飛ぶ (該当 tvdbId があればサブビューへ)
  const handleSearchPick = useCallback(
    (action: SearchAction) => {
      if (action.kind === 'program') {
        pushModalToUrl(setSearchParams, action.program.id);
      } else if (action.kind === 'series') {
        navigate(`/library/${action.entry.id}`);
      } else if (action.kind === 'channel') {
        const t = action.channel.type;
        setBcType(t === 'GR' || t === 'BS' || t === 'CS' ? t : 'all');
        navigate('/');
      } else if (action.kind === 'rule') {
        navigate('/rules');
      } else if (action.kind === 'recording') {
        if (action.recording.tvdbId) navigate(`/library/${action.recording.tvdbId}`);
        else navigate('/library');
      }
    },
    [navigate, setSearchParams, setBcType],
  );

  return (
    <div className="app">
      <Brand />
      <Header
        page={page}
        crumbs={crumbs}
        onCrumb={(idx) => {
          if (idx === null) navigate('/');
          else if (idx === 0) navigate('/library');
        }}
        onOpenSearch={() => setSearchOpen(true)}
        onCreateRule={() => navigate('/rules')}
      />
      <Sidebar
        active={page}
        onNav={(p) => {
          navigate(PAGE_PATHS[p as Page] ?? '/');
        }}
        counts={counts}
        system={systemForSidebar}
        recordingCount={recordingCount}
      />
      <main className="main">
        {isInitialLoading && (
          <div style={{ padding: 24, color: 'var(--fg-muted)', fontSize: 13 }}>
            サーバーから読み込み中…
          </div>
        )}

        {!isInitialLoading && (
          <Routes>
            <Route
              path="/"
              element={
                <>
                  <Subheader
                    density={density}
                    layout={layout}
                    onLayout={setLayout}
                    filter={genreFilter}
                    setFilter={setGenreFilter}
                    bcType={bcType}
                    setBcType={setBcType}
                    selectedDate={selectedDate}
                    onSelectDate={setSelectedDate}
                    displayedDate={displayedDate}
                  />
                  <div className="view-wrap">
                    {layout === 'grid' && (
                      <GridView
                        programs={filteredPrograms}
                        channels={visibleChannels}
                        onSelect={openModal}
                        selectedId={selectedProg}
                        reservedIds={reservedIds}
                        density={density}
                        baseDate={selectedDate}
                        daysLoaded={Math.max(1, schedule.loadedDays)}
                        onLoadMore={loadMoreDays}
                        onVisibleDateChange={setDisplayedDate}
                      />
                    )}
                    {layout === 'timeline' && (
                      <TimelineView
                        programs={filteredPrograms}
                        channels={visibleChannels}
                        onSelect={openModal}
                        selectedId={selectedProg}
                        reservedIds={reservedIds}
                        scrubRange={scrubRange}
                        setScrubRange={setScrubRange}
                        baseDate={selectedDate}
                        daysLoaded={Math.max(1, schedule.loadedDays)}
                        onLoadMore={loadMoreDays}
                        onVisibleDateChange={setDisplayedDate}
                      />
                    )}
                    {layout === 'agenda' && (
                      <AgendaView
                        programs={filteredPrograms}
                        channels={visibleChannels}
                        onSelect={openModal}
                        selectedId={selectedProg}
                        reservedIds={reservedIds}
                      />
                    )}
                  </div>
                </>
              }
            />
            <Route
              path="/rules"
              element={
                <RulesPage
                  rules={rules}
                  channels={channels}
                  recordings={library}
                  toggleRule={toggleRule}
                  updateRule={(id, patch) => void handleUpdateRule(id, patch)}
                  deleteRule={(id) => void handleDeleteRule(id)}
                  onCreate={() => {
                    navigate('/');
                    pushToast('番組を選んでルール化できます');
                  }}
                />
              }
            />
            <Route
              path="/library"
              element={
                <LibraryRouteView
                  rules={rules}
                  channels={channels}
                  recordings={library}
                  tvdbList={tvdbList}
                  toggleRule={toggleRule}
                  onDeleted={async (id: string) => {
                    try {
                      await api.recordings.remove(id);
                      await recordingsR.refresh();
                      pushToast('録画物を削除しました');
                    } catch (e) {
                      pushToast(`削除失敗: ${(e as Error).message}`, 'err');
                    }
                  }}
                />
              }
            />
            <Route
              path="/library/:tvdbId"
              element={
                <LibraryRouteView
                  rules={rules}
                  channels={channels}
                  recordings={library}
                  tvdbList={tvdbList}
                  toggleRule={toggleRule}
                  onDeleted={async (id: string) => {
                    try {
                      await api.recordings.remove(id);
                      await recordingsR.refresh();
                      pushToast('録画物を削除しました');
                    } catch (e) {
                      pushToast(`削除失敗: ${(e as Error).message}`, 'err');
                    }
                  }}
                />
              }
            />
            <Route
              path="/reserves"
              element={
                <ReservesPage
                  recordings={scheduledOrLive}
                  programs={programs}
                  onCancel={handleCancelReserve}
                  onStop={handleStopRecording}
                  onUpdate={handleUpdateReserve}
                  onPollRefresh={pollRefresh}
                  rules={rules}
                  channels={channels}
                  tvdb={tvdbCatalog}
                />
              }
            />
            <Route
              path="/discover"
              element={
                <DiscoverPage
                  existingSeriesIds={existingSeriesIdSet}
                  onAdded={(tv) => {
                    void rulesR.refresh();
                    pushToast(`シリーズ「${tv.title}」を TVDB に紐付けました`);
                  }}
                  onRemove={(tvdbId) => handleUnsubscribeSeries(tvdbId)}
                />
              }
            />
            <Route path="/settings" element={<SettingsPage pushToast={pushToast} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>

      {modalProg && (
        <ReserveModal
          program={modalProg}
          onClose={closeModal}
          onReserve={(p) => void handleReserve(p)}
          onCreateRule={(kw, p, ch) => void handleCreateRule(kw, p, ch)}
          onCreateSeriesLink={(tv, p, ch) => void handleCreateSeriesLink(tv, p, ch)}
          reservedIds={reservedIds}
          channels={channels}
          programs={programs}
          tvdb={tvdbCatalog}
          existingSeriesIds={existingSeriesIdSet}
          onUnsubscribeSeries={(tvdbId) => void handleUnsubscribeSeries(tvdbId)}
          recordingIdForProgram={recordingIdForProgram}
          onStopRecording={(recordingId) => void handleStopRecording(recordingId)}
          onTvdbChange={() => {
            void schedule.refresh();
            void tvdbR.refresh();
            pushToast('TVDB 紐付けを更新しました');
          }}
        />
      )}

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPick={handleSearchPick}
        channels={channels}
      />

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span className="toast-icon" />
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// Library route wrapper — maps :tvdbId → LibraryPage.view and translates
// setView() calls back into navigate(). This keeps LibraryPage itself
// untouched so the rest of its internals (filters, card/row view toggle)
// stay in component-local state + localStorage.
// =====================================================================
interface LibraryRouteViewProps {
  rules: Rule[];
  channels: Channel[];
  recordings: Recording[];
  tvdbList: TvdbEntry[];
  toggleRule: (id: number) => void | Promise<void>;
  onDeleted: (id: string) => void | Promise<void>;
}

function LibraryRouteView({
  rules,
  channels,
  recordings,
  tvdbList,
  toggleRule,
  onDeleted,
}: LibraryRouteViewProps) {
  const params = useParams<{ tvdbId?: string }>();
  const navigate = useNavigate();
  const parsed = params.tvdbId ? Number(params.tvdbId) : null;
  const view = parsed != null && Number.isFinite(parsed) ? parsed : null;
  const seriesRules = useMemo(() => rules.filter((r) => r.kind === 'series'), [rules]);

  return (
    <LibraryPage
      seriesRules={seriesRules}
      view={view}
      setView={(v) => {
        if (v == null) navigate('/library');
        else navigate(`/library/${v}`);
      }}
      toggleRule={(id) => void toggleRule(id)}
      onGoGuide={() => navigate('/')}
      channels={channels}
      recordings={recordings}
      tvdbCatalog={tvdbList}
      onDeleted={(id) => void onDeleted(id)}
    />
  );
}
