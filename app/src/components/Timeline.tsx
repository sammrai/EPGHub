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
  const rulerRef = useRef<HTMLDivElement | null>(null);

  // ルーラーを scroller の水平位置と同期。transform だけを触るので再レンダ不要。
  const syncRuler = (scrollX: number) => {
    if (rulerRef.current) {
      rulerRef.current.style.transform = `translateX(${-scrollX}px)`;
    }
  };

  // 初期スクロール: 現在時刻を左寄り (左端+80px) に置く。baseDate が変わる
  // 度に 1 度だけ適用。scrubRange と scrollLeft を双方向同期すると丸め誤差で
  // チャタリングするので、ここではプログラム側が「書く」のみ、読むのは onScroll。
  const didInitialScroll = useRef<string>('');
  useLayoutEffect(() => {
    if (!scrollerRef.current) return;
    if (didInitialScroll.current === baseDate) return;
    didInitialScroll.current = baseDate;
    const target = nowVisible ? Math.max(0, nowX - 80) : 0;
    scrollerRef.current.scrollLeft = target;
    syncRuler(target);
    const windowSpan = (scrollerRef.current.clientWidth - 160) / pxPerMin;
    setScrubRange({ start: target / pxPerMin, end: target / pxPerMin + windowSpan });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseDate]);

  const onMinimapClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!scrollerRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const centerMin = frac * totalMins;
    const windowSpan = scrubRange.end - scrubRange.start;
    const newStart = Math.max(0, Math.min(totalMins - windowSpan, centerMin - windowSpan / 2));
    const scrollX = newStart * pxPerMin;
    scrollerRef.current.scrollLeft = scrollX;
    syncRuler(scrollX);
    setScrubRange({ start: newStart, end: newStart + windowSpan });
  };

  const loadingMore = useRef(false);
  const lastVisibleDate = useRef<string>(baseDate);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const scrollX = el.scrollLeft;
    const windowSpan = (el.clientWidth - 160) / pxPerMin;
    const newStart = scrollX / pxPerMin;
    // scrubRange は minimap / ラベル用の state。onScroll で更新するが、
    // useEffect で scrollLeft を書き戻す経路を作らない (= チャタリング防止)。
    setScrubRange({ start: newStart, end: newStart + windowSpan });
    syncRuler(scrollX);
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

  return (
    <div className="tl-view">
      <div className="tl-ruler">
        <div
          ref={rulerRef}
          style={{ position: 'relative', width, height: '100%', willChange: 'transform' }}
        >
          {hourTicks.map(h => (
            <div
              key={h}
              className={`tl-tick ${h % 3 === 0 ? 'major' : ''}`}
              style={{ left: (h - START_HOUR) * 60 * pxPerMin }}
            >
              {String(h % 24).padStart(2, '0')}:00
            </div>
          ))}
          {nowVisible && (
            <div
              style={{
                position: 'absolute',
                left: nowX - 18,
                top: 6,
                color: 'var(--rec)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: 700,
                background: 'white',
                padding: '1px 4px',
                borderRadius: 3,
                border: '1px solid var(--rec)',
              }}
            >
              NOW {nowLabel}
            </div>
          )}
        </div>
      </div>

      <div className="tl-scroll" ref={scrollerRef} onScroll={onScroll}>
        <div style={{ position: 'relative', width: width + 160 }}>
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
                    const w = Math.max(28, (b - a) * pxPerMin - 2);
                    const isRes = reservedIds.has(progId(p));
                    const isRec = p.recording;
                    const isPast = p.endAt ? Date.parse(p.endAt) < Date.now() : false;
                    return (
                      <div
                        key={i}
                        className={[
                          'tl-prog',
                          isRes && !isRec && 'reserved',
                          isRec && 'recording',
                          isPast && 'past',
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
        <div className="mm-track" onMouseDown={onMinimapClick}>
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
