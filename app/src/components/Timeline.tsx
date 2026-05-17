// Horizontal timeline view with scrubbable minimap
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { UIEvent, MouseEvent } from 'react';
import { broadcastDayAt, toMin, progId } from '../lib/epg';
import { addDays } from '../lib/broadcastDay';
import { seriesRuleCovers } from '../lib/seriesRule';
import { Icon } from './Icon';
import type { Channel, Program } from '../data/types';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
function formatFullDateJa(ymd: string): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  if (!y || !mo || !d) return ymd;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const dow = DOW[dt.getUTCDay()];
  return `${y}年${String(mo).padStart(2, '0')}月${String(d).padStart(2, '0')}日(${dow})`;
}

// scrubRange は baseMs (= baseDate 05:00 JST) からの経過分。
export interface ScrubRange {
  start: number;
  end: number;
}

export interface TimelineViewProps {
  programs: Program[];
  channels: Channel[];
  onSelect: (p: Program) => void;
  selectedId: string | null;
  reservedIds: Set<string>;
  /** Channel-aware series-rule coverage: tvdb id → channel list (empty
   *  list = wildcard). Cells render the orange series-reserved variant
   *  only when the rule's channels include the program's channel. */
  seriesRuleChannels?: Map<number, string[]>;
  scrubRange: ScrubRange;
  setScrubRange: (range: ScrubRange) => void;
  /** Earliest loaded day (= leftmost of horizontal timeline). May shift
   *  backward as the user scrolls left and `onLoadPrior` prepends. */
  baseDate: string;
  /** The user-anchor day (= App's `selectedDate`). Stays put when a
   *  backward prepend shifts `baseDate` earlier. Used as the
   *  initial-scroll key so prepending doesn't re-fire centering. */
  anchorDate?: string;
  daysLoaded: number;
  onLoadMore: () => void;
  /** Called when the user wheels/scrolls left near the start. App will
   *  prepend a day before `baseDate`. Pass `undefined` to disable. */
  onLoadPrior?: () => void;
  /** 表示中の放送日を親に通知する (課題#13). baseDate を 0 日目として、
   *  scrollLeft の位置から放送日境界 (JST 05:00) を判定し、またぐたびに発火。 */
  onVisibleDateChange?: (ymd: string) => void;
  /** When set to a genre key, programs that don't match are kept in
   *  place but rendered dimmed so the surrounding grid context stays
   *  visible (`all` = no dim). */
  genreFilter?: string;
  /** Deep link `?modal=<id>` で外部から開かれた時、現時刻ではなくこの ISO の
   *  時刻が viewport 中央に来るように初期 scrollLeft を決める。null/undefined
   *  の通常 (in-app 起動) では「現時刻 80px 左」の従来挙動。 */
  scrollFocusIso?: string;
  /** Deep link 起動時の対象チャンネル ID。Timeline は縦軸がチャンネルなので、
   *  該当行が viewport 中央に来るよう scrollTop も寄せる (時刻の scrollLeft
   *  と対)。未指定なら垂直スクロールは触らない。 */
  scrollFocusCh?: string;
  /** "End-of-range" marker at the very left (= earliest loaded day's
   *  05:00 JST). True when no more past days can be loaded. */
  atPriorBound?: boolean;
  /** "End-of-range" marker at the very right. True when server has no
   *  more future EPG. */
  atForwardBound?: boolean;
}

export function TimelineView({
  programs,
  channels,
  onSelect,
  selectedId,
  reservedIds,
  seriesRuleChannels,
  scrubRange,
  setScrubRange,
  baseDate,
  anchorDate,
  daysLoaded,
  onLoadMore,
  onLoadPrior,
  onVisibleDateChange,
  genreFilter = 'all',
  scrollFocusIso,
  scrollFocusCh,
  atPriorBound,
  atForwardBound,
}: TimelineViewProps) {
  const START_HOUR = 5;
  const END_HOUR = START_HOUR + 24 * daysLoaded;
  const totalMins = (END_HOUR - START_HOUR) * 60;
  const pxPerMin = 4.0;
  const width = totalMins * pxPerMin;

  const baseMs = Date.parse(`${baseDate}T05:00:00+09:00`);
  const offsetMin = (iso: string | undefined, hhmm: string): number => {
    if (iso) return (Date.parse(iso) - baseMs) / 60000;
    const raw = toMin(hhmm);
    return raw < START_HOUR * 60 ? raw + 24 * 60 - START_HOUR * 60 : raw - START_HOUR * 60;
  };

  const nowOff = (Date.now() - baseMs) / 60000;
  const nowX = nowOff * pxPerMin;
  const nowVisible = nowOff >= 0 && nowOff <= totalMins;
  const nowLabel = (() => {
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  })();

  const hourTicks: number[] = [];
  for (let h = START_HOUR; h < END_HOUR; h++) hourTicks.push(h);

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // 初期スクロール — 役割を 2 つに分割:
  //  (1) day-nav 用: anchorDate が変わった時だけ「now or 左端」へ。Modal の
  //      open/close や backward 読み込みでは発火しない。
  //  (2) deep-link 用 (下の useEffect): mount 時に 1 回だけ、scrollFocusIso
  //      の時刻を中央に。それ以降は一切再計算しない。
  const scrollKey = anchorDate ?? baseDate;
  const lastScrollKey = useRef<string>('');
  useLayoutEffect(() => {
    if (!scrollerRef.current) return;
    if (lastScrollKey.current === scrollKey) return;
    const firstRun = lastScrollKey.current === '';
    lastScrollKey.current = scrollKey;
    // 初回 mount で deep-link がある場合は (2) に任せて何もしない
    // (= scrollFocusIso の値を上書きさせない)。
    if (firstRun && scrollFocusIso) return;
    const windowSpan = (scrollerRef.current.clientWidth - 160) / pxPerMin;
    const target = nowVisible ? Math.max(0, nowX - 80) : 0;
    scrollerRef.current.scrollLeft = target;
    setScrubRange({ start: target / pxPerMin, end: target / pxPerMin + windowSpan });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  // Deep link 起動時の中央化 — mount 時 1 回限り。以後は一切再計算しない。
  //  - 横方向: scrollFocusIso の時刻が viewport 中央に
  //  - 縦方向: scrollFocusCh の行が viewport 中央に
  // 行は data-ch-id 経由で DOM から実位置 (offsetTop) を取得する。row が
  // 描画される前に effect が走ると null になるので RAF で最大 ~1.3s 待つ。
  const didDeepLinkScroll = useRef(false);
  useLayoutEffect(() => {
    if (didDeepLinkScroll.current) return;
    if (!scrollerRef.current) return;
    if (!scrollFocusIso) {
      didDeepLinkScroll.current = true;
      return;
    }
    // 横方向: 同期的に計算可能 (DOM 不要)。
    const focusMin = (Date.parse(scrollFocusIso) - baseMs) / 60000;
    if (Number.isFinite(focusMin) && focusMin >= 0 && focusMin < totalMins) {
      const windowSpan = (scrollerRef.current.clientWidth - 160) / pxPerMin;
      const focusX = focusMin * pxPerMin;
      const target = Math.max(0, focusX - (windowSpan * pxPerMin) / 2);
      scrollerRef.current.scrollLeft = target;
      setScrubRange({ start: target / pxPerMin, end: target / pxPerMin + windowSpan });
    }
    // 縦方向: row が DOM に乗ったら offsetTop を測って中央へ。
    if (!scrollFocusCh) {
      didDeepLinkScroll.current = true;
      return;
    }
    let attempts = 0;
    let raf = 0;
    const tick = () => {
      attempts++;
      const scroller = scrollerRef.current;
      if (!scroller) { didDeepLinkScroll.current = true; return; }
      const row = scroller.querySelector<HTMLElement>(
        `.tl-row[data-ch-id="${CSS.escape(scrollFocusCh)}"]`,
      );
      if (row) {
        // Grid と同じく「scroller の上 1/4 付近」に配置 — modal は bottom
        // 寄りに出るので、上寄りにすると重なりを最小化できる。
        scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight * 0.25);
        didDeepLinkScroll.current = true;
        return;
      }
      if (attempts < 80) raf = requestAnimationFrame(tick);
      else didDeepLinkScroll.current = true;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mmTrackRef = useRef<HTMLDivElement | null>(null);
  const mmDraggingRef = useRef(false);
  // Apply a minimap X coordinate (clientX) as the new scroll position.
  // Window span is read live from the scroller element — reading it from
  // `scrubRange` would introduce a closure on stale state during drags.
  const applyMmPos = (clientX: number) => {
    if (!scrollerRef.current || !mmTrackRef.current) return;
    const rect = mmTrackRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const windowSpan = Math.max(
      1,
      (scrollerRef.current.clientWidth - 160) / pxPerMin,
    );
    const centerMin = frac * totalMins;
    const newStart = Math.max(
      0,
      Math.min(totalMins - windowSpan, centerMin - windowSpan / 2),
    );
    scrollerRef.current.scrollLeft = newStart * pxPerMin;
  };
  const onMinimapDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    mmDraggingRef.current = true;
    applyMmPos(e.clientX);
    e.preventDefault();
  };
  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      if (!mmDraggingRef.current) return;
      applyMmPos(e.clientX);
    };
    const onUp = () => {
      mmDraggingRef.current = false;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMins, pxPerMin]);

  // 両方向の遅延ロード — forward / backward を対称に扱う:
  //   forward : scrollWidth - scrollLeft - clientWidth < EDGE → onLoadMore
  //   backward: scrollLeft < EDGE → onLoadPrior
  // ロック用 ref で多重呼び出しを抑止。scrollLeft=0 にエッジ張り付きした
  // まま wheel left され続けても拾えるよう、wheel listener で同じ checkEdges
  // を走らせる。
  const EDGE_PX = 400;
  const loadingMore = useRef(false);
  const loadingPrior = useRef(false);
  const lastVisibleDate = useRef<string>(baseDate);
  const checkEdges = (el: HTMLDivElement) => {
    const remain = el.scrollWidth - (el.scrollLeft + el.clientWidth);
    if (onLoadMore && remain < EDGE_PX && !loadingMore.current) {
      loadingMore.current = true;
      onLoadMore();
    }
    if (onLoadPrior && el.scrollLeft < EDGE_PX && !loadingPrior.current) {
      loadingPrior.current = true;
      onLoadPrior();
    }
  };
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const scrollX = el.scrollLeft;
    const windowSpan = (el.clientWidth - 160) / pxPerMin;
    const newStart = scrollX / pxPerMin;
    setScrubRange({ start: newStart, end: newStart + windowSpan });
    checkEdges(el);
    // 放送日を跨いだら親に通知 (課題#13)。newStart (baseDate 05:00 からの分) を
    // 24h で刻んで day offset を出し、broadcastDayAt で YMD 化する。
    if (onVisibleDateChange) {
      const ymd = broadcastDayAt(baseDate, Math.max(0, newStart));
      if (ymd !== lastVisibleDate.current) {
        lastVisibleDate.current = ymd;
        onVisibleDateChange(ymd);
      }
    }
  };
  useEffect(() => {
    if (!scrollerRef.current) return;
    const el = scrollerRef.current;
    const onWheel = () => checkEdges(el);
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLoadMore, onLoadPrior]);
  useEffect(() => {
    loadingMore.current = false;
  }, [daysLoaded]);

  // baseDate が「前」にシフトした (= 過去日が prepend された) 時、見ている
  // 時刻位置がズレないよう scrollLeft を 1 日分 (= 1440 * pxPerMin) 押し
  // 右方向に補正する。
  const prevBaseDate = useRef<string>(baseDate);
  useLayoutEffect(() => {
    if (prevBaseDate.current === baseDate) return;
    const prev = prevBaseDate.current;
    prevBaseDate.current = baseDate;
    if (!prev || baseDate >= prev) return;
    if (!scrollerRef.current) return;
    const dayDiff = Math.round(
      (Date.parse(`${prev}T05:00:00+09:00`) -
        Date.parse(`${baseDate}T05:00:00+09:00`)) / 86400000,
    );
    if (dayDiff <= 0) return;
    scrollerRef.current.scrollLeft += dayDiff * 24 * 60 * pxPerMin;
    loadingPrior.current = false;
  }, [baseDate, pxPerMin]);

  // Click-and-drag pan. The horizontal scrollbar is hidden (the minimap
  // is the primary scrubber), so drag-to-scroll is how users navigate the
  // timeline. We only engage the pan when the mousedown target isn't a
  // program card — so clicking a program still opens the modal.
  const panRef = useRef<{ startX: number; startScroll: number; active: boolean }>({
    startX: 0,
    startScroll: 0,
    active: false,
  });
  const onPanDown = (e: MouseEvent<HTMLDivElement>) => {
    if (!scrollerRef.current) return;
    if (e.button !== 0) return;
    // Let clicks on programs/channel-col/interactive bits fall through.
    const target = e.target as HTMLElement;
    if (target.closest('.tl-prog') || target.closest('.tl-ch') || target.closest('a, button')) {
      return;
    }
    panRef.current = {
      startX: e.clientX,
      startScroll: scrollerRef.current.scrollLeft,
      active: true,
    };
    scrollerRef.current.classList.add('panning');
  };
  const onPanMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!panRef.current.active || !scrollerRef.current) return;
    const dx = e.clientX - panRef.current.startX;
    scrollerRef.current.scrollLeft = panRef.current.startScroll - dx;
  };
  const endPan = () => {
    if (!panRef.current.active) return;
    panRef.current.active = false;
    scrollerRef.current?.classList.remove('panning');
  };

  return (
    <div className="tl-view">
      <div
        className="tl-scroll"
        ref={scrollerRef}
        onScroll={onScroll}
        onMouseDown={onPanDown}
        onMouseMove={onPanMove}
        onMouseUp={endPan}
        onMouseLeave={endPan}
      >
        <div style={{ position: 'relative', width: width + 160 }}>
          <div className="tl-ruler">
            {hourTicks.map(h => (
              <div
                key={h}
                className={`tl-tick ${h % 3 === 0 ? 'major' : ''}`}
                style={{ left: 160 + (h - START_HOUR) * 60 * pxPerMin }}
              >
                {String(h % 24).padStart(2, '0')}:00
              </div>
            ))}
          </div>
          {channels.map(ch => {
            const progs = programs.filter(p => p.ch === ch.id);
            const totalDurMin = progs.reduce((s, p) => {
              const a = offsetMin(p.startAt, p.start);
              const b = offsetMin(p.endAt, p.end);
              const len = b > a ? b - a : b + 24 * 60 - a;
              return s + Math.max(0, len);
            }, 0);
            return (
              <div key={ch.id} className="tl-row" data-ch-id={ch.id}>
                <div className="tl-ch">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="agenda-ch-num">{ch.number}</span>
                    <span className="ch-head-type">{ch.type}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{ch.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
                    {progs.length}本 · {Math.round(totalDurMin / 60)}時間
                  </div>
                </div>
                <div className="tl-strip" style={{ width, minHeight: 140 }}>
                  {progs.map((p, i) => {
                    const a = offsetMin(p.startAt, p.start);
                    const bRaw = offsetMin(p.endAt, p.end);
                    const b = !p.endAt && bRaw < a ? bRaw + 24 * 60 : bRaw;
                    if (b <= 0 || a >= totalMins) return null;
                    const left = a * pxPerMin;
                    // Cells must NOT overlap — adjacent cells touch exactly
                    // at the time boundary so each cell's `border-right`
                    // hairline stays visible (a +1 overlap would let the
                    // next cell's white background paint over the line).
                    const w = Math.max(28, (b - a) * pxPerMin);
                    const isRes = reservedIds.has(progId(p));
                    const isSeriesRes =
                      isRes && p.tvdb?.id != null && seriesRuleCovers(seriesRuleChannels, p.tvdb.id, p.ch);
                    const isRec = p.recording;
                    const isPast = p.endAt ? Date.parse(p.endAt) < Date.now() : false;
                    const isDimmed = genreFilter !== 'all' && p.genre.key !== genreFilter;
                    const narrow = w < 130;
                    return (
                      <div
                        key={i}
                        className={[
                          'tl-prog',
                          narrow && 'narrow',
                          isRes && !isRec && !isSeriesRes && 'reserved',
                          isSeriesRes && !isRec && 'series-reserved',
                          isRec && 'recording',
                          isPast && 'past',
                          isDimmed && 'dimmed',
                          selectedId === progId(p) && 'selected',
                        ].filter(Boolean).join(' ')}
                        style={{ left, width: w }}
                        onClick={() => onSelect(p)}
                      >
                        <div className="tl-prog-meta">
                          <strong>{p.start}</strong>
                          {isRec && <span className="prog-rec-tag">REC</span>}
                          {isSeriesRes && !isRec && (
                            <span className="prog-series-tag">
                              <Icon name="cycle" size={10} /> シリーズ
                            </span>
                          )}
                          {isRes && !isRec && !isSeriesRes && (
                            <span className="prog-resv-tag">予約</span>
                          )}
                        </div>
                        <div className="tl-prog-title">{p.title}</div>
                        {!narrow && (p.desc || p.ep) && (
                          <div className="tl-prog-desc">{p.desc ?? p.ep}</div>
                        )}
                        {p.tvdbSeason != null && p.tvdbEpisode != null && (
                          <div className="prog-se-foot">
                            S{p.tvdbSeason}E{p.tvdbEpisode}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {nowVisible && <div className="tl-now" style={{ left: nowX + 160 }} />}
          {atPriorBound && (
            <div className="tl-edge tl-edge-left" style={{ left: 160 }}>
              <div className="tl-edge-label">
                <span className="tl-edge-dot" />
                {formatFullDateJa(baseDate)} 05:00 以前は未取得
              </div>
            </div>
          )}
          {atForwardBound && (
            <div
              className="tl-edge tl-edge-right"
              style={{ left: width + 160 - 36 }}
            >
              <div className="tl-edge-label">
                <span className="tl-edge-dot" />
                {formatFullDateJa(addDays(baseDate, Math.max(0, daysLoaded - 1)))} 以降は EPG 未取得
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="tl-minimap">
        <div className="mm-track" ref={mmTrackRef} onMouseDown={onMinimapDown}>
          {hourTicks.filter(h => (h - START_HOUR) % 4 === 0).map(h => (
            <div key={h} className="mm-hour" style={{ left: `${((h - START_HOUR) / (END_HOUR - START_HOUR)) * 100}%` }}>
              {String(h % 24).padStart(2, '0')}
            </div>
          ))}
          {programs.filter(p => p.recording || reservedIds.has(progId(p))).slice(0, 60).map((p, i) => {
            const off = offsetMin(p.startAt, p.start);
            if (off < 0 || off > totalMins) return null;
            const x = (off / totalMins) * 100;
            return (
              <div
                key={i}
                className={`mm-dot ${p.recording ? 'rec' : 'resv'}`}
                style={{ left: `${x}%` }}
                title={p.title}
              />
            );
          })}
          {nowVisible && <div className="mm-now" style={{ left: `${(nowOff / totalMins) * 100}%` }} />}
          <div
            className="mm-window"
            style={{
              left:  `${(scrubRange.start / totalMins) * 100}%`,
              width: `${((scrubRange.end - scrubRange.start) / totalMins) * 100}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
