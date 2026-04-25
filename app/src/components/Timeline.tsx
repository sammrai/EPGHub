// Horizontal timeline view with scrubbable minimap
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { UIEvent, MouseEvent } from 'react';
import { broadcastDayAt, toMin, progId } from '../lib/epg';
import type { Channel, Program } from '../data/types';

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
  scrubRange: ScrubRange;
  setScrubRange: (range: ScrubRange) => void;
  baseDate: string;
  daysLoaded: number;
  onLoadMore: () => void;
  /** 表示中の放送日を親に通知する (課題#13). baseDate を 0 日目として、
   *  scrollLeft の位置から放送日境界 (JST 05:00) を判定し、またぐたびに発火。 */
  onVisibleDateChange?: (ymd: string) => void;
  /** When set to a genre key, programs that don't match are kept in
   *  place but rendered dimmed so the surrounding grid context stays
   *  visible (`all` = no dim). */
  genreFilter?: string;
}

export function TimelineView({
  programs,
  channels,
  onSelect,
  selectedId,
  reservedIds,
  scrubRange,
  setScrubRange,
  baseDate,
  daysLoaded,
  onLoadMore,
  onVisibleDateChange,
  genreFilter = 'all',
}: TimelineViewProps) {
  const START_HOUR = 5;
  const END_HOUR = START_HOUR + 24 * daysLoaded;
  const totalMins = (END_HOUR - START_HOUR) * 60;
  const pxPerMin = 2.6;
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

  // 初期スクロール: 現在時刻を左寄り (左端+80px) に置く。baseDate が変わる
  // 度に 1 度だけ適用。ルーラーは scroll コンテナ内に sticky で組み込まれて
  // いるので、JS での transform 同期は不要 (以前は onScroll で transform を
  // 更新していたが、1 フレーム遅れて微妙にズレていた)。
  const didInitialScroll = useRef<string>('');
  useLayoutEffect(() => {
    if (!scrollerRef.current) return;
    if (didInitialScroll.current === baseDate) return;
    didInitialScroll.current = baseDate;
    const target = nowVisible ? Math.max(0, nowX - 80) : 0;
    scrollerRef.current.scrollLeft = target;
    const windowSpan = (scrollerRef.current.clientWidth - 160) / pxPerMin;
    setScrubRange({ start: target / pxPerMin, end: target / pxPerMin + windowSpan });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseDate]);

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

  const loadingMore = useRef(false);
  const lastVisibleDate = useRef<string>(baseDate);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const scrollX = el.scrollLeft;
    const windowSpan = (el.clientWidth - 160) / pxPerMin;
    const newStart = scrollX / pxPerMin;
    setScrubRange({ start: newStart, end: newStart + windowSpan });
    // 右端 400px を切ったら次の 1 日を追加読み込み。
    const remain = el.scrollWidth - (el.scrollLeft + el.clientWidth);
    if (remain < 400 && !loadingMore.current) {
      loadingMore.current = true;
      onLoadMore();
    }
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
    loadingMore.current = false;
  }, [daysLoaded]);

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
              <div key={ch.id} className="tl-row">
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
                <div className="tl-strip" style={{ width, minHeight: 78 }}>
                  {progs.map((p, i) => {
                    const a = offsetMin(p.startAt, p.start);
                    const bRaw = offsetMin(p.endAt, p.end);
                    const b = !p.endAt && bRaw < a ? bRaw + 24 * 60 : bRaw;
                    if (b <= 0 || a >= totalMins) return null;
                    const left = a * pxPerMin;
                    // +1 so each program's right-border overlaps the next
                    // program's left-border on the same pixel (single line).
                    const w = Math.max(28, (b - a) * pxPerMin + 1);
                    const isRes = reservedIds.has(progId(p));
                    const isRec = p.recording;
                    const isPast = p.endAt ? Date.parse(p.endAt) < Date.now() : false;
                    const isDimmed = genreFilter !== 'all' && p.genre.key !== genreFilter;
                    return (
                      <div
                        key={i}
                        className={[
                          'tl-prog',
                          isRes && !isRec && 'reserved',
                          isRec && 'recording',
                          isPast && 'past',
                          isDimmed && 'dimmed',
                          selectedId === progId(p) && 'selected',
                        ].filter(Boolean).join(' ')}
                        style={{ left, width: w }}
                        onClick={() => onSelect(p)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>
                          {p.genre && <span className="g-dot" style={{ background: p.genre.dot }} />}
                          <strong style={{ color: 'var(--fg-secondary)' }}>{p.start}</strong>
                          <span>–{p.end}</span>
                          {isRes && <span className="agenda-badge resv" style={{ padding: '0 4px', fontSize: 8, marginLeft: 'auto' }}>RESV</span>}
                        </div>
                        <div style={{ fontWeight: 500, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: w < 140 ? 'nowrap' : 'normal', lineHeight: 1.3 }}>
                          {p.title}
                        </div>
                        {w > 160 && p.ep && <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>{p.ep}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {nowVisible && <div className="tl-now" style={{ left: nowX + 160 }} />}
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
