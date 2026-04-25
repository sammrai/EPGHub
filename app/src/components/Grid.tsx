// Classic grid (vertical time) — columns = channels
import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { broadcastDayAt, progId } from '../lib/epg';
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

// JST calendar arithmetic. JavaScript's Date is UTC-based; we add 9h so
// getUTC* returns JST components, then treat the result as a pure calendar.
function jstDateParts(offsetDays: number): { ymd: string; mmdd: string; dow: string; y: number; m: number; d: number } {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 86400_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const mm = String(m).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return {
    ymd: `${y}-${mm}-${dd}`,
    mmdd: `${mm}/${dd}`,
    dow: DOW[d.getUTCDay()],
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
  /** Anchor date for the grid (YYYY-MM-DD, JST broadcast day). The grid
   *  renders from `baseDate` 05:00 JST over `daysLoaded × 24` hours. */
  baseDate: string;
  /** How many broadcast days the grid currently renders. Grows as the user
   *  scrolls toward the bottom (triggers `onLoadMore`). */
  daysLoaded: number;
  onLoadMore: () => void;
  /** Called as the user scrolls past broadcast-day boundaries so the
   *  Subheader can show a live "表示中: MM/DD" chip (課題#13). Receives
   *  `baseDate`, `baseDate+1`, … as YYYY-MM-DD. */
  onVisibleDateChange?: (ymd: string) => void;
  /** 'all' renders everything at full strength. Any other value renders
   *  non-matching programs faded (they stay in place to preserve grid
   *  context rather than being fully removed). */
  genreFilter?: string;
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

export function GridView({ programs, channels, onSelect, selectedId, density, reservedIds, baseDate, daysLoaded, onLoadMore, onVisibleDateChange, genreFilter = 'all' }: GridViewProps) {
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

  // 初期スクロール: 現在時刻を上寄り (ビュー top+80px) に。baseDate が変わる
  // (day-nav クリック等) ごとに再適用する。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const didInitialScroll = useRef<string>('');
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const scroller = findScrollParent(rootRef.current);
    if (!scroller) return;
    // baseDate が変わる度に 1 回だけ初期化する。density 変更等では動かさない。
    if (didInitialScroll.current === baseDate) return;
    didInitialScroll.current = baseDate;
    if (nowVisible) {
      scroller.scrollTop = Math.max(0, nowOffset - 80);
    } else {
      scroller.scrollTop = 0;
    }
    scroller.scrollLeft = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseDate]);

  // 無限スクロール: 底まで残り 400px を切ったら onLoadMore。スクロール頻度が
  // 高いので passive listener + ロック用 ref で多重呼び出しを抑止する。
  // 同じリスナーで表示中の放送日も算出して onVisibleDateChange に流す (課題#13)。
  const loadingMore = useRef(false);
  const lastVisibleDate = useRef<string>(baseDate);
  useEffect(() => {
    if (!rootRef.current) return;
    const scroller = findScrollParent(rootRef.current);
    if (!scroller) return;
    const onScroll = () => {
      const remain = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
      if (remain < 400 && !loadingMore.current) {
        loadingMore.current = true;
        onLoadMore();
      }
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
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [onLoadMore, onVisibleDateChange, baseDate, pxPerMin]);
  useEffect(() => {
    // 新しい日が載ったらロック解除。
    loadingMore.current = false;
  }, [daysLoaded]);

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
                // Cards float on a tinted body — 3px gap so adjacent
                // programs don't touch.
                const height = Math.max(18, rawH - 3);
                const isReserved = reservedIds.has(progId(p));
                const isPast = p.endAt ? Date.parse(p.endAt) < Date.now() : false;
                const isRec = p.recording;
                const short = height < 34;
                const isDimmed = genreFilter !== 'all' && p.genre.key !== genreFilter;
                return (
                  <div
                    key={idx}
                    data-testid={`prog-${progId(p)}`}
                    className={[
                      'prog',
                      isReserved && !isRec && 'reserved',
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
                        {p.hd && <span>HD</span>}
                        {isRec && <span style={{ color: 'var(--rec)', fontWeight: 700 }}>● REC</span>}
                      </div>
                      {!short && <div className="prog-title">{p.title}</div>}
                      {short && <div className="prog-title" style={{ fontSize: 11 }}>{p.title}</div>}
                      {!short && p.ep && height > 90 && <div className="prog-sub">{p.ep}</div>}
                    </div>
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
    </div>
  );
}
