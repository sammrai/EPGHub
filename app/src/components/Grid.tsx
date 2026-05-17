// Classic grid (vertical time) — columns = channels
import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { broadcastDayAt, progId } from '../lib/epg';
import { addDays, jstTodayYmd } from '../lib/broadcastDay';
import { seriesRuleCovers } from '../lib/seriesRule';
import type { BcType, Channel, Program } from '../data/types';

export type GridDensity = 'compact' | 'normal' | 'roomy';
export type GridLayout = 'grid' | 'timeline' | 'agenda';
export type GridBcType = BcType | 'all';
export type GenreFilter = string;

export interface SubheaderProps {
  density: GridDensity;
  layout: GridLayout;
  onLayout: (layout: GridLayout) => void;
  filter: GenreFilter;
  setFilter: (key: GenreFilter) => void;
  bcType: GridBcType;
  setBcType: (type: GridBcType) => void;
  /** Currently-selected JST date as `YYYY-MM-DD`. */
  selectedDate: string;
  onSelectDate: (date: string) => void;
  /** Broadcast day currently visible as the user scrolls. When this
   *  differs from `selectedDate` we add a secondary "表示中: MM/DD" chip
   *  so it's obvious which day is on screen (課題#13). */
  displayedDate?: string;
}

interface DayEntry {
  k: string;       // YYYY-MM-DD
  w: string;       // 曜日
  d: string;       // MM/DD
  /** Short label for the dropdown: TODAY / 明日 / 明後日 / N日後. */
  sub: string;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

// JST 放送日基準 (05:00 境界) で today + offsetDays を返す。App.tsx の
// `selectedDate` は jstTodayYmd() で「いま放送中の日」を起点に計算され
// るので、サブヘッダの日付ピルもそれに揃える必要がある。`+9h` の純粋
// カレンダー日で計算すると、JST 00:00–05:00 帯で 1 日ずれて「明日」を
// 押した結果が放送日 +2 になってしまう (e2e date-nav が落ちた原因)。
function jstDateParts(offsetDays: number): { ymd: string; mmdd: string; dow: string; y: number; m: number; d: number } {
  const ymd = addDays(jstTodayYmd(), offsetDays);
  const [y, m, day] = ymd.split('-').map(Number);
  const mm = String(m).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  // 曜日は YYYY-MM-DD を UTC とみなして算出 (タイムゾーンに依らない).
  const dow = DOW[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return {
    ymd,
    mmdd: `${mm}/${dd}`,
    dow,
    y,
    m,
    d: day,
  };
}

// Dropdown range: today + 6 days ahead (7 entries, "今日以降1w分").
function buildDays(): DayEntry[] {
  const subs: Record<number, string> = { 0: 'TODAY', 1: '明日', 2: '明後日' };
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const parts = jstDateParts(offset);
    return {
      k: parts.ymd,
      w: parts.dow,
      d: parts.mmdd,
      sub: subs[offset] ?? `${offset}日後`,
    };
  });
}

// Given a YYYY-MM-DD, return the "TODAY / 明日 / N日後" tag if it falls
// within today..today+6, else an empty string (past or further out).
function offsetTag(ymd: string): string {
  for (let i = 0; i <= 6; i++) {
    if (jstDateParts(i).ymd === ymd) {
      if (i === 0) return 'TODAY';
      if (i === 1) return '明日';
      if (i === 2) return '明後日';
      return `${i}日後`;
    }
  }
  return '';
}

function formatFullDateJa(ymd: string): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  if (!y || !mo || !d) return ymd;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const dow = DOW[dt.getUTCDay()];
  return `${y}年${String(mo).padStart(2, '0')}月${String(d).padStart(2, '0')}日(${dow})`;
}

interface GenreEntry {
  k: string;
  label: string;
  dot: string | null;
}

interface BcEntry {
  k: GridBcType;
  label: string;
}

export function Subheader({ layout, onLayout, filter, setFilter, bcType, setBcType, selectedDate, onSelectDate, displayedDate }: SubheaderProps) {
  const days = buildDays();
  // The pill reflects what is actually on screen as the user scrolls —
  // TODAY/明日/N日後 all track the scroll position, not the originally
  // selected date. When no scroll position is reported yet we fall back
  // to the explicit selectedDate.
  const pillDate = displayedDate || selectedDate;
  const pillTag = offsetTag(pillDate);
  const pillLabel = formatFullDateJa(pillDate);

  const [menuOpen, setMenuOpen] = useState(false);
  const pillWrapRef = useRef<HTMLDivElement>(null);
  const pillBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Genre "その他" dropdown. The 4 most-watched Japanese genres stay inline
  // as chips; the rarer ones fold into this dropdown to keep the subheader
  // horizontally compact.
  const [genreMoreOpen, setGenreMoreOpen] = useState(false);
  const genreMoreWrapRef = useRef<HTMLDivElement>(null);
  const genreMoreBtnRef = useRef<HTMLButtonElement>(null);
  const genreMoreMenuRef = useRef<HTMLDivElement>(null);
  const [genreMorePos, setGenreMorePos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!genreMoreOpen || !genreMoreBtnRef.current) {
      setGenreMorePos(null);
      return;
    }
    const rect = genreMoreBtnRef.current.getBoundingClientRect();
    setGenreMorePos({ top: rect.bottom + 6, left: rect.left });
  }, [genreMoreOpen]);
  useEffect(() => {
    if (!genreMoreOpen) return;
    function onDown(e: MouseEvent) {
      const inWrap = genreMoreWrapRef.current?.contains(e.target as Node);
      const inMenu = genreMoreMenuRef.current?.contains(e.target as Node);
      if (!inWrap && !inMenu) setGenreMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setGenreMoreOpen(false);
    }
    function onResize() {
      setGenreMoreOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [genreMoreOpen]);
  // The subheader has `overflow-x: auto` for the chip row, which clips any
  // absolutely-positioned child. To escape the clip, the dropdown uses
  // `position: fixed` with coordinates computed from the pill's bounding
  // rect — recomputed whenever the menu (re)opens.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!menuOpen || !pillBtnRef.current) {
      setMenuPos(null);
      return;
    }
    const rect = pillBtnRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 6, left: rect.left });
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      const inPill = pillWrapRef.current?.contains(e.target as Node);
      const inMenu = menuRef.current?.contains(e.target as Node);
      if (!inPill && !inMenu) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    function onScroll() {
      setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
    };
  }, [menuOpen]);

  const genres: GenreEntry[] = [
    { k: 'all',   label: '全て',          dot: null },
    { k: 'drama', label: 'ドラマ',        dot: 'oklch(0.62 0.12 20)' },
    { k: 'anime', label: 'アニメ',        dot: 'oklch(0.65 0.14 300)' },
    { k: 'var',   label: 'バラエティ',     dot: 'oklch(0.7 0.13 80)' },
    { k: 'sport', label: 'スポーツ',       dot: 'oklch(0.6 0.14 150)' },
    { k: 'doc',   label: 'ドキュメンタリー', dot: 'oklch(0.55 0.08 200)' },
    { k: 'movie', label: '映画',          dot: 'oklch(0.5 0.1 40)' },
    { k: 'music', label: '音楽',          dot: 'oklch(0.62 0.12 340)' },
    { k: 'news',  label: 'ニュース',       dot: 'oklch(0.6 0.02 250)' },
  ];
  // Primary chips = frequently toggled; rest go behind a "その他 ▾" dropdown
  // to keep the subheader horizontally compact.
  const PRIMARY_GENRE_KEYS = new Set(['all', 'drama', 'anime', 'var', 'movie']);
  const primaryGenres = genres.filter((g) => PRIMARY_GENRE_KEYS.has(g.k));
  const secondaryGenres = genres.filter((g) => !PRIMARY_GENRE_KEYS.has(g.k));
  const activeSecondary = secondaryGenres.find((g) => g.k === filter);
  const bc: BcEntry[] = [
    { k: 'all', label: '全波' },
    { k: 'GR',  label: '地デジ' },
    { k: 'BS',  label: 'BS' },
    { k: 'CS',  label: 'CS' },
  ];

  return (
    <div className="subheader">
      <div className="date-pill-wrap" ref={pillWrapRef}>
        <button
          ref={pillBtnRef}
          type="button"
          className={`date-pill${menuOpen ? ' open' : ''}`}
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
        >
          {pillTag && <span className="today">{pillTag}</span>}
          <span>{pillLabel}</span>
          <Icon name="chevD" size={11} />
        </button>
        {menuOpen && menuPos && (
          <div
            ref={menuRef}
            className="date-pill-menu"
            role="listbox"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {days.map((d) => {
              const selected = d.k === selectedDate;
              return (
                <button
                  key={d.k}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`dpm-item${selected ? ' active' : ''}`}
                  onClick={() => {
                    onSelectDate(d.k);
                    setMenuOpen(false);
                  }}
                >
                  <span className="dpm-tag">{d.sub}</span>
                  <span className="dpm-date">{d.w} {d.d}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="seg" style={{ marginRight: 4 }}>
        {bc.map(b => (
          <button
            key={b.k}
            className={`seg-btn ${bcType === b.k ? 'active' : ''}`}
            onClick={() => setBcType(b.k)}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <div className="genre-chips">
        {primaryGenres.map((g) => (
          <button
            key={g.k}
            type="button"
            className={`filter-chip${filter === g.k ? ' on' : ''}`}
            onClick={() => setFilter(g.k)}
          >
            {g.dot && <span className="dot" style={{ background: g.dot }} />}
            {g.label}
          </button>
        ))}
        <div className="genre-more-wrap" ref={genreMoreWrapRef}>
          <button
            ref={genreMoreBtnRef}
            type="button"
            className={`filter-chip${activeSecondary ? ' on' : ''}`}
            aria-haspopup="listbox"
            aria-expanded={genreMoreOpen}
            onClick={() => setGenreMoreOpen((o) => !o)}
          >
            {activeSecondary ? (
              <>
                {activeSecondary.dot && (
                  <span className="dot" style={{ background: activeSecondary.dot }} />
                )}
                {activeSecondary.label}
              </>
            ) : (
              'その他'
            )}
            <Icon name="chevD" size={10} />
          </button>
          {genreMoreOpen && genreMorePos && (
            <div
              ref={genreMoreMenuRef}
              className="genre-more-menu"
              role="listbox"
              style={{ top: genreMorePos.top, left: genreMorePos.left }}
            >
              {secondaryGenres.map((g) => (
                <button
                  key={g.k}
                  type="button"
                  role="option"
                  aria-selected={filter === g.k}
                  className={`gmm-item${filter === g.k ? ' active' : ''}`}
                  onClick={() => {
                    setFilter(g.k);
                    setGenreMoreOpen(false);
                  }}
                >
                  {g.dot && <span className="dot" style={{ background: g.dot }} />}
                  <span>{g.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="seg">
        <button
          className={`seg-btn icon-only ${layout === 'grid' ? 'active' : ''}`}
          onClick={() => onLayout('grid')}
          title="グリッド"
          aria-label="グリッド"
        >
          <Icon name="grid" size={14} />
        </button>
        <button
          className={`seg-btn icon-only ${layout === 'timeline' ? 'active' : ''}`}
          onClick={() => onLayout('timeline')}
          title="タイムライン"
          aria-label="タイムライン"
        >
          <Icon name="timeline" size={14} />
        </button>
        <button
          className={`seg-btn icon-only ${layout === 'agenda' ? 'active' : ''}`}
          onClick={() => onLayout('agenda')}
          title="アジェンダ"
          aria-label="アジェンダ"
        >
          <Icon name="list" size={14} />
        </button>
      </div>
    </div>
  );
}

// ============ GRID VIEW ============
export interface GridViewProps {
  programs: Program[];
  channels: Channel[];
  onSelect: (p: Program) => void;
  selectedId: string | null;
  density: GridDensity;
  reservedIds: Set<string>;
  /** Channel-aware view of enabled series rules: tvdb id → channel list.
   *  A reserved program renders in the orange "series-reserved" variant
   *  only when its `program.ch` is in the rule's channel list (or the
   *  list is empty, meaning wildcard). When the same tvdb id is reserved
   *  on a channel the rule does NOT cover (e.g. a duplicate from a
   *  different rule), the cell stays in the blue "reserved" variant. */
  seriesRuleChannels?: Map<number, string[]>;
  /** Anchor date for the grid (YYYY-MM-DD, JST broadcast day). The grid
   *  renders from `baseDate` 05:00 JST over `daysLoaded × 24` hours.
   *  This is the EARLIEST loaded day (may shift backward as the user
   *  wheels up and `onLoadPrior` prepends a prior day). */
  baseDate: string;
  /** The user-anchor date (= App's `selectedDate`). Stays put when a
   *  backward prepend shifts `baseDate` earlier. Used as the initial-
   *  scroll key so wheel-up prepending doesn't re-trigger the
   *  now-centering useLayoutEffect. */
  anchorDate?: string;
  /** How many broadcast days the grid currently renders. Grows as the user
   *  scrolls toward the bottom (triggers `onLoadMore`) or wheel-up at the
   *  top (triggers `onLoadPrior`, which prepends a day before `baseDate`). */
  daysLoaded: number;
  onLoadMore: () => void;
  /** Called when the user wheel-scrolls upward near the top. App will
   *  prepend a day before `baseDate` (= shift `baseDate` back by 1) so
   *  the user can see programs from earlier days. Pass `undefined` to
   *  disable backward load (e.g., already at today's broadcast day). */
  onLoadPrior?: () => void;
  /** Render an "end-of-range" marker at the very top of the grid (= the
   *  earliest loaded day's 05:00 JST). True when no further past days
   *  can be loaded (App: `priorDaysLoaded >= maxPriorDays`). */
  atPriorBound?: boolean;
  /** Render an "end-of-range" marker at the very bottom (= the latest
   *  loaded day's 29:00 JST). True when the server has no more future
   *  EPG (App: `schedule.exhausted`). */
  atForwardBound?: boolean;
  /** Called as the user scrolls past broadcast-day boundaries so the
   *  Subheader can show a live "表示中: MM/DD" chip (課題#13). Receives
   *  `baseDate`, `baseDate+1`, … as YYYY-MM-DD. */
  onVisibleDateChange?: (ymd: string) => void;
  /** 'all' renders everything at full strength. Any other value renders
   *  non-matching programs faded (they stay in place to preserve grid
   *  context rather than being fully removed). */
  genreFilter?: string;
  /** Deep link `?modal=<id>` で外部から開かれた時、現時刻ではなくこの ISO の
   *  時刻が viewport 中央に来るように初期スクロールする。null/undefined の
   *  通常 (in-app 起動) では「現時刻 80px 上」の従来挙動。 */
  scrollFocusIso?: string;
  /** Deep link 起動時の対象チャンネル ID。scrollLeft を寄せて該当列も viewport
   *  内に入るようにする (時刻軸センタリングと対) 。未指定なら scrollLeft=0 のまま。 */
  scrollFocusCh?: string;
}

interface GridCssVars extends CSSProperties {
  '--cols': number;
  '--col-w': string;
  '--px-per-min': string;
}

// 親 scroll コンテナ (`.view-wrap`) を遡って見つける。Grid はそれ自身で
// スクロール領域を持たず、App の外側の wrap に載る構造になっている。
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.classList.contains('view-wrap')) return cur;
    const style = getComputedStyle(cur);
    if (/(auto|scroll)/.test(style.overflowY)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function GridView({ programs, channels, onSelect, selectedId, density, reservedIds, seriesRuleChannels, baseDate, anchorDate, daysLoaded, onLoadMore, onLoadPrior, onVisibleDateChange, genreFilter = 'all', scrollFocusIso, scrollFocusCh, atPriorBound, atForwardBound }: GridViewProps) {
  // 放送日連続ビュー: baseDate 05:00 JST を 0 分起点に、daysLoaded × 24時間分
  // を一枚のタイムラインで描画。スクロールが底近くに達すると onLoadMore で
  // 更に 1 日追加読み込みする (無限スクロール)。
  const START_HOUR = 5;
  const END_HOUR = START_HOUR + 24 * daysLoaded;
  const totalMins = (END_HOUR - START_HOUR) * 60;

  const pxPerMin = density === 'compact' ? 1.0 : density === 'roomy' ? 1.7 : 1.35;
  const colW = density === 'compact' ? 150 : density === 'roomy' ? 210 : 180;

  const baseMs = Date.parse(`${baseDate}T05:00:00+09:00`);

  // ISO → baseMs 起点の分。startAt 無しは HH:MM からフォールバック (fixture 互換)。
  const offsetMin = (iso: string | undefined, hhmm: string): number => {
    if (iso) return (Date.parse(iso) - baseMs) / 60000;
    const [h, m] = hhmm.split(':').map(Number);
    const raw = h * 60 + m;
    return raw < START_HOUR * 60 ? raw + 24 * 60 - START_HOUR * 60 : raw - START_HOUR * 60;
  };

  // Focus zone: from "now" to +3h is rendered at 2× scale so currently-
  // airing and the next ~3 hours of programs dominate the viewport. Past
  // programs and anything 3h+ ahead use the regular pxPerMin density. The
  // zone is only active when `now` lands inside the loaded broadcast-day
  // range (i.e. viewing today) — past/future base dates scale linearly so
  // the view stays predictable.
  const nowMinFromBase = (Date.now() - baseMs) / 60000;
  const focusActive = nowMinFromBase > 0 && nowMinFromBase < totalMins;
  const FOCUS_AHEAD_MIN = 180;
  const FOCUS_SCALE = 2;
  const focusStart = focusActive ? nowMinFromBase : -1;
  const focusEnd = focusActive ? Math.min(totalMins, nowMinFromBase + FOCUS_AHEAD_MIN) : -1;

  // Convert a minute-from-baseMs value into the corresponding Y pixel.
  // Piecewise linear: identity×pxPerMin before focusStart, ×(pxPerMin*SCALE)
  // inside the focus window, identity×pxPerMin after focusEnd (with the
  // focus-zone width added back in).
  const focusGrowthPx = focusActive
    ? (focusEnd - focusStart) * pxPerMin * (FOCUS_SCALE - 1)
    : 0;
  const timeToPx = (min: number): number => {
    if (!focusActive) return min * pxPerMin;
    if (min <= focusStart) return min * pxPerMin;
    if (min >= focusEnd) {
      return focusStart * pxPerMin
        + (focusEnd - focusStart) * pxPerMin * FOCUS_SCALE
        + (min - focusEnd) * pxPerMin;
    }
    return focusStart * pxPerMin + (min - focusStart) * pxPerMin * FOCUS_SCALE;
  };
  const totalHeightPx = totalMins * pxPerMin + focusGrowthPx;

  const nowOffset = timeToPx(nowMinFromBase);
  const nowVisible = focusActive;
  const nowLabel = (() => {
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  })();

  const hourTicks: number[] = [];
  for (let h = START_HOUR; h < END_HOUR; h++) {
    hourTicks.push(h);
  }

  const gridStyle: GridCssVars = {
    '--cols': channels.length,
    '--col-w': `${colW}px`,
    '--px-per-min': `${pxPerMin}px`,
  };

  // 役割を 2 つに分割した初期スクロール:
  //  (1) day-nav 用 (この useLayoutEffect): anchorDate (= selectedDate) が
  //      変わった時だけ「現在時刻を上寄り」or「scrollTop=0」へ。
  //      Modal の open/close や backward 読み込みでは発火しない。
  //  (2) deep-link 用 (下の useEffect, mount 時 1 回限り): RAF で target セル
  //      を探し、scroller 上 1/4 + 該当列中央に置く。modal と被ったら押し上げる。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollKey = anchorDate ?? baseDate;
  const lastScrollKey = useRef<string>('');
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const scroller = findScrollParent(rootRef.current);
    if (!scroller) return;
    if (lastScrollKey.current === scrollKey) return;
    const firstRun = lastScrollKey.current === '';
    lastScrollKey.current = scrollKey;
    // 初回 mount で deep-link が指定されている場合は (2) に任せる
    // — ここで上書きすると一瞬今日へ動いてから target へ戻る flash になる。
    if (firstRun && scrollFocusIso) return;
    if (nowVisible) {
      scroller.scrollTop = Math.max(0, nowOffset - 80);
    } else {
      scroller.scrollTop = 0;
    }
    scroller.scrollLeft = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  // Deep link 起動時の精密スクロール — **mount 時 1 回限り**。
  // target セル & modal が DOM に乗ったら、target を scroller の上 1/4 +
  // 該当列の channel area センターに置き、modal と被らないよう modal の
  // 真上 (24px マージン) に追加で押し上げる。
  // 一度確定したら以後は無視 — wheel-up での backward 読み込みも、ユーザの
  // 任意 scroll も、modal の ❌ も、何も再計算しない (= grid が勝手に動かない)。
  const didDeepLinkScroll = useRef(false);
  useEffect(() => {
    if (didDeepLinkScroll.current) return;
    if (!scrollFocusIso || !scrollFocusCh) {
      didDeepLinkScroll.current = true; // deep-link が無い mount → 不要を記録
      return;
    }
    if (!rootRef.current) return;
    const scroller = findScrollParent(rootRef.current);
    if (!scroller) return;
    let attempts = 0;
    let initialApplied = false;
    let stableFrames = 0;
    let raf = 0;
    const MAX_FRAMES = 80; // ~1.3s at 60fps
    const cellTopInScroller = (el: HTMLElement): number => {
      let y = 0;
      let cur: HTMLElement | null = el;
      while (cur && cur !== scroller) {
        y += cur.offsetTop;
        cur = cur.offsetParent as HTMLElement | null;
      }
      return y;
    };
    const targetSel = `[data-testid="prog-${CSS.escape(scrollFocusCh)}_${scrollFocusIso}"]`;
    const finish = () => {
      didDeepLinkScroll.current = true;
    };
    const tick = () => {
      attempts++;
      const target = scroller.querySelector<HTMLElement>(targetSel);
      if (target) {
        if (!initialApplied) {
          const cellY = cellTopInScroller(target);
          scroller.scrollTop = Math.max(0, cellY - scroller.clientHeight * 0.25);
          const cellRect = target.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          const cellContentX = cellRect.left - scrollerRect.left + scroller.scrollLeft;
          const firstCol = scroller.querySelector<HTMLElement>('.ch-col');
          const timeColW = firstCol ? firstCol.offsetLeft : 0;
          const channelAreaCenter = timeColW + (scroller.clientWidth - timeColW) / 2;
          scroller.scrollLeft = Math.max(
            0,
            cellContentX + cellRect.width / 2 - channelAreaCenter,
          );
          initialApplied = true;
        }
        const modal = document.querySelector<HTMLElement>('.guide-panel-floating');
        if (modal) {
          const t = target.getBoundingClientRect();
          const m = modal.getBoundingClientRect();
          const overlapH = t.left < m.right && t.right > m.left;
          const overlapV = t.top < m.bottom && t.bottom > m.top;
          if (overlapH && overlapV) {
            const margin = 24;
            const desiredTop = m.top - t.height - margin;
            const delta = t.top - desiredTop;
            scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
            stableFrames = 0;
          } else {
            stableFrames++;
            if (stableFrames >= 10) {
              finish();
              return;
            }
          }
        }
      }
      if (attempts < MAX_FRAMES) raf = requestAnimationFrame(tick);
      else finish();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // ❶ scrollFocusIso/Ch は mount 時の deep-link 情報 (App 側で凍結済)。
    // ❷ 依存に入れないので mount 後一切再 fire しない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 両方向の遅延ロード — forward / backward を対称に扱う:
  //   forward : scrollHeight - scrollTop - clientHeight < EDGE → onLoadMore
  //   backward: scrollTop < EDGE → onLoadPrior
  // それぞれ ロック用 ref で多重呼び出しを抑止し、対応する props が
  // undefined なら無効化される (App 側で境界に達したら undefined を渡す)。
  // scroll event は scrollTop が動いた時しか発火しないので、エッジに張り
  // ついたまま wheel し続けた場合に備えて wheel listener も同じチェックを
  // 走らせる。同じリスナー内で表示中の放送日も算出 (課題#13)。
  const EDGE_PX = 400;
  const loadingMore = useRef(false);
  const loadingPrior = useRef(false);
  const lastVisibleDate = useRef<string>(baseDate);
  useEffect(() => {
    if (!rootRef.current) return;
    const scroller = findScrollParent(rootRef.current);
    if (!scroller) return;
    const checkEdges = () => {
      const remain = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
      if (onLoadMore && remain < EDGE_PX && !loadingMore.current) {
        loadingMore.current = true;
        onLoadMore();
      }
      if (onLoadPrior && scroller.scrollTop < EDGE_PX && !loadingPrior.current) {
        loadingPrior.current = true;
        onLoadPrior();
      }
    };
    const onScroll = () => {
      checkEdges();
      if (onVisibleDateChange) {
        // Invert timeToPx for the scroll position. The focus zone is a
        // simple piecewise function so the inverse is also piecewise.
        const y = Math.max(0, scroller.scrollTop);
        let mins: number;
        if (!focusActive) {
          mins = y / pxPerMin;
        } else {
          const yFocusStart = focusStart * pxPerMin;
          const yFocusEnd = yFocusStart + (focusEnd - focusStart) * pxPerMin * FOCUS_SCALE;
          if (y <= yFocusStart) mins = y / pxPerMin;
          else if (y >= yFocusEnd) mins = focusEnd + (y - yFocusEnd) / pxPerMin;
          else mins = focusStart + (y - yFocusStart) / (pxPerMin * FOCUS_SCALE);
        }
        const ymd = broadcastDayAt(baseDate, mins);
        if (ymd !== lastVisibleDate.current) {
          lastVisibleDate.current = ymd;
          onVisibleDateChange(ymd);
        }
      }
    };
    // wheel: scrollTop が動かない (エッジ張り付き状態) でも、ユーザの
    // スクロール意図を捉えてエッジチェックを発火する。
    const onWheel = () => checkEdges();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
    };
  }, [onLoadMore, onLoadPrior, onVisibleDateChange, baseDate, pxPerMin]);
  useEffect(() => {
    // 新しい日が載ったら forward 側のロック解除。
    loadingMore.current = false;
  }, [daysLoaded]);

  // baseDate が「前」にシフトした (= 過去日が prepend された) 時、見ている
  // コンテンツが新たに加わった日のぶんだけ scroll content 内で下に押し下げ
  // られるので、scrollTop も同量増やして visual position を維持する。
  // そうしないと wheel-up のたびに視点が常に「新しく加わった先頭」に飛んで
  // しまう。同じ effect で backward ロックも解除。
  const prevBaseDate = useRef<string>(baseDate);
  useLayoutEffect(() => {
    if (prevBaseDate.current === baseDate) return;
    const prev = prevBaseDate.current;
    prevBaseDate.current = baseDate;
    if (!prev || baseDate >= prev) return;
    const scroller = rootRef.current ? findScrollParent(rootRef.current) : null;
    if (!scroller) return;
    const dayDiff = Math.round(
      (Date.parse(`${prev}T05:00:00+09:00`) -
        Date.parse(`${baseDate}T05:00:00+09:00`)) / 86400000,
    );
    if (dayDiff <= 0) return;
    scroller.scrollTop += dayDiff * 24 * 60 * pxPerMin;
    loadingPrior.current = false;
  }, [baseDate, pxPerMin]);

  // Last loaded day for the forward-bound caption (= baseDate + daysLoaded-1
  // is the last 24h-slot start). When schedule has empty trailing days the
  // App still keeps them rendered, so this is the calendar boundary, not
  // necessarily the last *non-empty* day.
  const firstDay = baseDate;
  const lastDay = addDays(baseDate, Math.max(0, daysLoaded - 1));

  return (
    <div className="grid-view" style={gridStyle} ref={rootRef}>
      <div className="grid-channels">
        <div className="ch-head-corner" />
        {channels.map(ch => (
          <div key={ch.id} className="ch-head">
            <div className="ch-head-num">{ch.number} · <span style={{ color: ch.color }}>●</span> {ch.type}</div>
            <div className="ch-head-name">{ch.name}</div>
          </div>
        ))}
      </div>
      {atPriorBound && (
        <div className="grid-edge grid-edge-top" aria-hidden="false">
          <div className="grid-edge-label">
            <span className="grid-edge-dot" />
            ここが起点 — {formatFullDateJa(firstDay)} 05:00 より前は表示できません
          </div>
        </div>
      )}
      <div className="grid-body" style={{ height: totalHeightPx }}>
        <div className="time-col">
          {hourTicks.map((h) => {
            // Tick heights follow the same focus-zone mapping as program
            // blocks so the time axis stays aligned — hours inside the
            // ±90-min window around now are drawn 2× taller than outside.
            const startMin = (h - START_HOUR) * 60;
            const endMin = startMin + 60;
            const tickH = timeToPx(endMin) - timeToPx(startMin);
            return (
              <div key={h} className="time-tick" style={{ height: tickH }}>
                {String(h % 24).padStart(2, '0')}
              </div>
            );
          })}
        </div>
        {channels.map(ch => {
          const progs = programs.filter(p => p.ch === ch.id);
          return (
            <div key={ch.id} className="ch-col">
              {progs.map((p, idx) => {
                const startOff = offsetMin(p.startAt, p.start);
                const endOffRaw = offsetMin(p.endAt, p.end);
                const endOff = !p.endAt && endOffRaw < startOff ? endOffRaw + 24 * 60 : endOffRaw;
                if (endOff <= 0 || startOff >= totalMins) return null;
                // Positions respect the non-linear focus zone so programs
                // inside ±90 min of now get 2× vertical real estate.
                const top = timeToPx(startOff);
                const rawH = timeToPx(endOff) - top;
                // Cells must touch exactly so each `border-bottom` hairline
                // sits at the next cell's top edge — no gap (the design
                // guide stitches cells into a continuous grid via
                // border-bottom + border-right).
                const height = Math.max(18, rawH);
                const isReserved = reservedIds.has(progId(p));
                const isSeriesReserved =
                  isReserved && p.tvdb?.id != null && seriesRuleCovers(seriesRuleChannels, p.tvdb.id, p.ch);
                const isPast = p.endAt ? Date.parse(p.endAt) < Date.now() : false;
                const isRec = p.recording;
                const short = height < 38;
                const isDimmed = genreFilter !== 'all' && p.genre.key !== genreFilter;
                return (
                  <div
                    key={idx}
                    data-testid={`prog-${progId(p)}`}
                    className={[
                      'prog',
                      isReserved && !isRec && !isSeriesReserved && 'reserved',
                      isSeriesReserved && !isRec && 'series-reserved',
                      isRec && 'recording',
                      isPast && 'past',
                      isDimmed && 'dimmed',
                      selectedId === progId(p) && 'selected',
                    ].filter(Boolean).join(' ')}
                    style={{ top, height }}
                    onClick={() => onSelect(p)}
                  >
                    <div className="prog-content">
                      <div className="prog-meta">
                        <span style={{ color: 'var(--fg-secondary)', fontWeight: 600 }}>{p.start}</span>
                        {p.genre && <span className="g-dot" style={{ background: p.genre.dot }} />}
                        {isRec && <span className="prog-rec-tag">● REC</span>}
                        {isSeriesReserved && !isRec && (
                          <span className="prog-series-tag">
                            <Icon name="cycle" size={10} /> シリーズ
                          </span>
                        )}
                        {isReserved && !isRec && !isSeriesReserved && (
                          <span className="prog-resv-tag">予約</span>
                        )}
                      </div>
                      {short ? (
                        <div className="prog-title compact">{p.title}</div>
                      ) : (
                        <div className="prog-title">{p.title}</div>
                      )}
                      {!short && height > 64 && (p.desc || p.ep) && (
                        <div className="prog-desc">{p.desc ?? p.ep}</div>
                      )}
                    </div>
                    {p.tvdbSeason != null && p.tvdbEpisode != null && (
                      <div className="prog-se-foot">
                        S{p.tvdbSeason}E{p.tvdbEpisode}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {/* now line */}
        {nowVisible && (
          <div className="now-line" style={{ top: nowOffset }}>
            <span className="now-label">{nowLabel}</span>
          </div>
        )}
      </div>
      {atForwardBound && (
        <div className="grid-edge grid-edge-bottom" aria-hidden="false">
          <div className="grid-edge-label">
            <span className="grid-edge-dot" />
            ここまで放送予定 — {formatFullDateJa(lastDay)} 以降は EPG 未取得
          </div>
        </div>
      )}
    </div>
  );
}
