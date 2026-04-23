// Pages: Library (merged), Reserves (status), Discover, Settings
// Rules lives in Agenda.tsx

import { useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { pushModalToUrl } from '../lib/modalUrl';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { toMin, MOCK_NOW_MIN, progId, seriesCounts } from '../lib/epg';
import type {
  Channel,
  Program,
  Recording,
  Rule,
  TvdbEntry,
  TvdbSeries,
  TvdbMovie,
} from '../data/types';
import { api } from '../api/epghub';
import type {
  ApiAdminSettings,
  ApiAdminSettingsPatch,
  ApiPriority,
  ApiQuality,
  ApiRankingItem,
  ApiRankingGenre,
  ApiRecDefaults,
  ApiRecEncodePreset,
  ApiRecording,
  ApiUpdateRecording,
  ApiTvdbEntry,
  ApiChannel,
  ApiChannelSource,
  ApiDeviceLiveStatus,
  ApiProbeChannelSourceResult,
  ApiScannedDevice,
  ApiGpuEncoder,
  ApiGpuProbeResult,
  ApiGpuStatus,
  ApiSystemStatus,
} from '../api/epghub';

// ============ SHARED ============
export interface PageHeadProps {
  title: string;
  children?: ReactNode;
}

/** Shared top row for every page: title on the left, global search in
 *  the center, optional action buttons on the right. The search pill
 *  dispatches a window-level event so App.tsx can open the command
 *  palette without PageHead needing the callback as a prop. */
export const PageHead = ({ title, children }: PageHeadProps) => (
  <div className="page-head">
    <div className="page-head-main">
      <h1>{title}</h1>
    </div>
    <div className="page-head-search">
      <button
        type="button"
        className="body-search"
        onClick={() => window.dispatchEvent(new CustomEvent('epghub:open-search'))}
        aria-label="検索を開く"
      >
        <Icon name="search" size={14} />
        <span className="body-search-placeholder">検索…</span>
        <span className="kbd">⌘K</span>
      </button>
    </div>
    {children && <div className="page-head-actions">{children}</div>}
  </div>
);

export type StatPillTone = 'accent' | 'ok' | 'rec' | undefined;

export interface StatPillProps {
  label: string;
  value: ReactNode;
  tone?: StatPillTone;
}

export const StatPill = ({ label, value, tone }: StatPillProps) => (
  <div
    style={{
      padding: '5px 12px',
      background: 'var(--bg-muted)',
      border: '1px solid var(--border)',
      borderRadius: 999,
      fontSize: 11.5,
      color: 'var(--fg-muted)',
    }}
  >
    {label}{' '}
    <strong
      style={{
        color:
          tone === 'accent'
            ? 'var(--accent)'
            : tone === 'ok'
            ? 'var(--ok)'
            : tone === 'rec'
            ? 'var(--rec)'
            : 'var(--fg)',
        marginLeft: 4,
        fontFamily: 'var(--font-mono)',
      }}
    >
      {value}
    </strong>
  </div>
);

type PosterSize = 'sm' | 'md' | 'lg' | 'xl';

interface PosterProps {
  seed: string;
  label: string;
  size?: PosterSize;
  /** Real poster URL (e.g. TVDB artwork). When present, replaces the
   *  procedural gradient. Falsy / non-http values fall back to the gradient. */
  poster?: string | null;
}

const Poster = ({ seed, label, size = 'md', poster }: PosterProps) => {
  const w = size === 'sm' ? 36 : size === 'lg' ? 104 : size === 'xl' ? 140 : 56;
  const h = size === 'sm' ? 52 : size === 'lg' ? 148 : size === 'xl' ? 200 : 80;
  const source = seed || 'x';
  let hash = 0;
  for (let i = 0; i < source.length; i++)
    hash = (source.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  const hue = Math.abs(hash) % 360;
  const hasUrl = !!poster && /^https?:\/\//.test(poster);
  const base = {
    width: w,
    height: h,
    flexShrink: 0,
    borderRadius: 5,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize:
      size === 'sm' ? 10 : size === 'lg' ? 18 : size === 'xl' ? 24 : 13,
    fontWeight: 700,
    color: 'white',
    letterSpacing: '0.02em',
    boxShadow:
      '0 1px 3px oklch(0 0 0 / 0.15), inset 0 0 0 1px oklch(1 0 0 / 0.08)',
    fontFamily: 'var(--font-mono)',
  } as const;
  if (hasUrl) {
    return (
      <div
        style={{
          ...base,
          backgroundImage: `url("${poster}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundColor: 'var(--bg-muted)',
        }}
      />
    );
  }
  return (
    <div
      style={{
        ...base,
        background: `linear-gradient(145deg, oklch(0.55 0.13 ${hue}), oklch(0.38 0.11 ${
          (hue + 40) % 360
        }))`,
      }}
    >
      {(label || '?').slice(0, 2).toUpperCase()}
    </div>
  );
};

interface EmptyStateProps {
  icon: IconName;
  title: string;
  desc: string;
}

const EmptyState = ({ icon, title, desc }: EmptyStateProps) => (
  <div
    style={{
      padding: 60,
      textAlign: 'center',
      border: '1px dashed var(--border)',
      borderRadius: 'var(--radius)',
      background: 'var(--bg-muted)',
    }}
  >
    <div
      style={{
        display: 'inline-flex',
        width: 48,
        height: 48,
        borderRadius: 999,
        background: 'var(--bg-elev)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 12,
        color: 'var(--fg-subtle)',
      }}
    >
      <Icon name={icon} size={20} />
    </div>
    <div
      style={{
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--fg)',
        marginBottom: 4,
      }}
    >
      {title}
    </div>
    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{desc}</div>
  </div>
);

interface StateTagProps {
  state: Recording['state'];
}

const StateTag = ({ state }: StateTagProps) => {
  if (state === 'encoding')
    return (
      <span className="state-tag encoding">
        <span className="pulse-dot" /> エンコード中
      </span>
    );
  // R0 removed the old 'queued' encode state — encode is now modelled as
  // state='encoding' from the moment the job enters the queue. Library rows
  // are state='ready', so no status tag there.
  return null;
};

// ============ ライブラリ (Library - Movies / Series / Other, like Plex's library kinds) ============
type LibFilter = 'all' | 'series' | 'movie' | 'other';
type LibViewMode = 'card' | 'table';

interface SeriesListEntry {
  // nullable: a recording may be linked to a TVDB series even when no
  // auto-record rule exists (e.g. user picked 単発 on a series episode).
  // In that case the card shows "手動録画" instead of the 自動/停止 toggle.
  rule: Rule | null;
  tvdb: TvdbSeries;
  recorded: Recording[];
}

interface MovieListEntry {
  r: Recording;
  tvdb: TvdbMovie;
}

interface SeriesItem {
  kind: 'series';
  sortKey: string;
  type: 'series';
  title: string;
  subtitle: string;
  s: SeriesListEntry;
}

interface MovieItem {
  kind: 'movie';
  sortKey: string;
  type: 'movie';
  title: string;
  subtitle: string;
  m: MovieListEntry;
}

interface OtherItem {
  kind: 'other';
  sortKey: string;
  type: 'other';
  title: string;
  subtitle: string;
  r: Recording;
}

type LibItem = SeriesItem | MovieItem | OtherItem;

export interface LibraryPageProps {
  seriesRules: Rule[];
  view: number | null;
  setView: (v: number | null) => void;
  toggleRule: (id: number) => void;
  onGoGuide: () => void;
  channels: Channel[];
  /** Ready recordings (state='ready'). Caller is expected to filter the
   *  unified /recordings list before passing it in. */
  recordings: Recording[];
  tvdbCatalog: TvdbEntry[];
  /** Called after the user confirms delete. Parent is expected to hit the API
   *  and refresh the recordings list. */
  onDeleted?: (id: string) => void;
}

export const LibraryPage = ({
  seriesRules,
  view,
  setView,
  toggleRule,
  onGoGuide,
  channels,
  recordings,
  tvdbCatalog,
  onDeleted,
}: LibraryPageProps) => {
  const [filter, setFilter] = useState<LibFilter>('all');
  const [movieView, setMovieView] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<LibViewMode>(
    () => (localStorage.getItem('lib-view') as LibViewMode) || 'card'
  );

  useEffect(() => {
    localStorage.setItem('lib-view', viewMode);
  }, [viewMode]);

  // Build series list — one entry per TVDB series that either has a rule
  // OR has at least one recording. Earlier this was rules-only, which hid
  // manually-recorded series episodes (source:once on a TVDB-linked series)
  // because they fell through every category: not a rule-backed series,
  // not a movie, not "other" either (tvdbId was set). Now we take the
  // union of (rule-linked series) ∪ (recording-linked series).
  const seriesIdsFromRules = new Set<number>(
    seriesRules
      .filter((r) => !!r.tvdb && (r.tvdb.type === 'series' || (r.tvdb as { type?: string }).type === undefined))
      .map((r) => r.tvdb!.id)
  );
  const seriesIdsFromRecordings = new Set<number>(
    recordings
      .filter((r) => r.tvdbId != null)
      .map((r) => r.tvdbId!)
      .filter((id) => {
        const t = tvdbCatalog.find((x) => x.id === id);
        // include when tvdb says series, or when type is missing (legacy data)
        return t != null && (t.type === 'series' || (t as { type?: string }).type === undefined);
      })
  );
  const allSeriesIds = new Set<number>([
    ...seriesIdsFromRules,
    ...seriesIdsFromRecordings,
  ]);
  const seriesList: SeriesListEntry[] = Array.from(allSeriesIds)
    .map<SeriesListEntry | null>((id) => {
      const tvdb = (tvdbCatalog.find((t) => t.id === id) ?? seriesRules.find((r) => r.tvdb?.id === id)?.tvdb) as TvdbSeries | undefined;
      if (!tvdb) return null;
      const rule = seriesRules.find((r) => r.tvdb?.id === id) ?? null;
      const recordedEps = recordings.filter((x) => x.tvdbId === id);
      return { rule, tvdb, recorded: recordedEps };
    })
    .filter((e): e is SeriesListEntry => e != null);

  // Movies: recordings linked to a TVDB entry with type='movie'. Each movie recording is its own item.
  const movieItems: MovieListEntry[] = recordings
    .filter((r): r is Recording & { tvdbId: number } => {
      if (r.tvdbId == null) return false;
      const t = tvdbCatalog.find((x) => x.id === r.tvdbId);
      return t?.type === 'movie';
    })
    .map((r) => {
      const tvdb = tvdbCatalog.find((x) => x.id === r.tvdbId) as TvdbMovie;
      return { r, tvdb };
    });

  // Other: recordings with no TVDB link (news, sports, unmatched one-offs)
  const otherRecordings = recordings.filter((r) => r.tvdbId == null);

  if (movieView != null) {
    const m = movieItems.find((x) => x.r.id === movieView);
    if (m)
      return (
        <MovieDetail
          m={m}
          channels={channels}
          onBack={() => setMovieView(null)}
          onDeleted={onDeleted}
        />
      );
  }

  if (view != null) {
    const s = seriesList.find((x) => x.tvdb.id === view);
    if (s)
      return (
        <SeriesDetail
          series={s}
          onBack={() => setView(null)}
          toggleRule={toggleRule}
        />
      );
  }

  const totalFiles = recordings.length;
  const totalSize = recordings.reduce((s, r) => s + r.size, 0).toFixed(1);
  // Post-R0: encode lifecycle has a single 'encoding' state (queued was
  // collapsed into encoding in the schema). Library rows are state='ready',
  // so this is usually 0 but we keep the pill for forward-compat with the
  // encoder surface.
  const encodingCount = recordings.filter((r) => r.state === 'encoding').length;

  // Build unified item list by kind
  const items: LibItem[] = [
    ...seriesList.map<SeriesItem>((s) => ({
      kind: 'series',
      sortKey: s.recorded[0]?.air || '2999',
      type: 'series',
      title: s.tvdb.title,
      subtitle: s.tvdb.titleEn,
      s,
    })),
    ...movieItems.map<MovieItem>((m) => ({
      kind: 'movie',
      sortKey: m.r.air,
      type: 'movie',
      title: m.tvdb.title,
      subtitle: m.tvdb.titleEn,
      m,
    })),
    ...otherRecordings.map<OtherItem>((r) => ({
      kind: 'other',
      sortKey: r.air,
      type: 'other',
      title: r.title,
      subtitle: r.epTitle || '',
      r,
    })),
  ];

  const filtered = items.filter((it) => filter === 'all' || it.type === filter);
  filtered.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  return (
    <div className="page">
      <PageHead title="ライブラリ" />

      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 18,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <StatPill label="合計" value={totalFiles} />
        <StatPill label="シリーズ" value={seriesList.length} tone="accent" />
        <StatPill label="映画" value={movieItems.length} />
        <StatPill label="その他" value={otherRecordings.length} />
        {encodingCount > 0 && (
          <StatPill label="エンコード" value={encodingCount} tone="rec" />
        )}
        <StatPill label="容量" value={`${totalSize} GB`} />
        <div style={{ flex: 1 }} />
        <div className="seg-sm">
          <button
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >
            すべて
          </button>
          <button
            className={filter === 'series' ? 'active' : ''}
            onClick={() => setFilter('series')}
          >
            シリーズ
          </button>
          <button
            className={filter === 'movie' ? 'active' : ''}
            onClick={() => setFilter('movie')}
          >
            映画
          </button>
          <button
            className={filter === 'other' ? 'active' : ''}
            onClick={() => setFilter('other')}
          >
            その他
          </button>
        </div>
        <div className="seg-sm" title="表示切替">
          <button
            className={viewMode === 'card' ? 'active' : ''}
            onClick={() => setViewMode('card')}
            title="カード"
          >
            <Icon name="grid" size={11} />
          </button>
          <button
            className={viewMode === 'table' ? 'active' : ''}
            onClick={() => setViewMode('table')}
            title="テーブル"
          >
            <Icon name="list" size={11} />
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="disk"
          title="該当する録画がありません"
          desc="フィルタを変更してください。"
        />
      ) : viewMode === 'card' ? (
        <div className="lib-card-grid">
          {filtered.map((it) => {
            if (it.kind === 'series')
              return (
                <SeriesLibCard
                  key={'s' + it.s.tvdb.id}
                  s={it.s}
                  onOpen={() => setView(it.s.tvdb.id)}
                />
              );
            if (it.kind === 'movie')
              return (
                <MovieLibCard key={'m' + it.m.r.id} m={it.m} channels={channels} onDeleted={onDeleted} onOpen={() => setMovieView(it.m.r.id)} />
              );
            return (
              <RecordingLibCard
                key={'r' + it.r.id}
                r={it.r}
                channels={channels}
                onDeleted={onDeleted}
                onOpen={it.r.tvdbId != null ? (rec) => setView(rec.tvdbId!) : undefined}
              />
            );
          })}
        </div>
      ) : (
        <div className="res-table lib-table">
          <div className="res-table-head">
            <div>種別</div>
            <div>タイトル</div>
            <div>チャンネル / ソース</div>
            <div>件数 / 日付</div>
            <div>サイズ</div>
            <div>状態</div>
          </div>
          {filtered.map((it) => {
            if (it.kind === 'series')
              return (
                <SeriesLibRow
                  key={'s' + it.s.tvdb.id}
                  s={it.s}
                  onOpen={() => setView(it.s.tvdb.id)}
                />
              );
            if (it.kind === 'movie')
              return (
                <MovieLibRow key={'m' + it.m.r.id} m={it.m} channels={channels} onDeleted={onDeleted} onOpen={() => setMovieView(it.m.r.id)} />
              );
            return (
              <RecordingLibRow
                key={'r' + it.r.id}
                r={it.r}
                channels={channels}
                onDeleted={onDeleted}
                onOpen={it.r.tvdbId != null ? (rec) => setView(rec.tvdbId!) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

interface SeriesLibCardProps {
  s: SeriesListEntry;
  onOpen: () => void;
}

const SeriesLibCard = ({ s, onOpen }: SeriesLibCardProps) => {
  const counts = seriesCounts(s.tvdb, s.recorded);
  // Only render a progress bar when we have an authoritative denominator.
  // With local-only counts, recorded.length === currentEp, so the bar would
  // always sit at 100% and mislead the user.
  const pct = counts.partial
    ? null
    : Math.min(100, (s.recorded.length / Math.max(counts.currentEp, 1)) * 100);
  const totalSize = s.recorded.reduce((a, e) => a + e.size, 0).toFixed(1);
  const seasonLabel =
    counts.totalSeasons > 0 ? `${counts.totalSeasons}シーズン` : 'シーズン情報なし';
  return (
    <div
      className={`series-lib-card ${s.rule && !s.rule.enabled ? 'off' : ''}`}
      onClick={onOpen}
    >
      <div className="lib-card-kind">
        <span className="kind-tag tvdb">シリーズ</span>
      </div>
      <Poster seed={s.tvdb.slug} label={s.tvdb.titleEn} size="xl" poster={s.tvdb.poster} />
      <div className="series-lib-meta">
        <div className="series-lib-title">{s.tvdb.title}</div>
        <div className="series-lib-sub">{s.tvdb.titleEn}</div>
        <div className="series-lib-progress">
          <div className="series-lib-progress-label">
            <span>
              {seasonLabel} · {totalSize} GB
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>
              {s.recorded.length}話録画
            </span>
          </div>
          {pct != null && (
            <div className="series-lib-bar">
              <div className="series-lib-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <div className="series-lib-footer">
          {s.rule ? (
            <span className={`series-lib-status ${s.rule.enabled ? 'on' : 'off'}`}>
              <span className="dot" /> {s.rule.enabled ? '自動録画中' : '停止'}
            </span>
          ) : (
            <span className="series-lib-status manual" title="ルール登録なし。録画は単発で行われています">
              <span className="dot" /> 手動録画
            </span>
          )}
          <span style={{ color: 'var(--fg-subtle)', fontSize: 10.5 }}>
            {s.tvdb.network}
          </span>
        </div>
      </div>
    </div>
  );
};

// Shared confirm+delete wrapper. Returns an onClick for a 削除 button.
function makeDeleteHandler(
  r: Pick<Recording, 'id' | 'title'>,
  onDeleted: ((id: string) => void) | undefined
) {
  if (!onDeleted) return undefined;
  return (e: ReactMouseEvent) => {
    e.stopPropagation();
    const label = r.title ? `「${r.title.slice(0, 40)}」` : '';
    if (window.confirm(`${label}を削除します。ファイルごと完全に消えます。よろしいですか？`)) {
      onDeleted(r.id);
    }
  };
}

interface RecordingLibCardProps {
  r: Recording;
  channels: Channel[];
  onDeleted?: (id: string) => void;
  onOpen?: (r: Recording) => void;
}

const RecordingLibCard = ({ r, channels, onDeleted, onOpen }: RecordingLibCardProps) => {
  const ch = channels.find((c) => c.id === r.ch);
  const handleDelete = makeDeleteHandler(r, onDeleted);
  return (
    <div
      className={`series-lib-card recording-card ${onOpen ? 'clickable' : ''}`}
      onClick={onOpen ? () => onOpen(r) : undefined}
    >
      <div className="lib-card-kind">
        <span className="kind-tag manual">録画物</span>
      </div>
      <Poster seed={r.id + (r.title || '')} label={r.title} size="xl" />
      <div className="series-lib-meta">
        <div className="series-lib-title">{r.title}</div>
        <div className="series-lib-sub">{r.epTitle || r.air}</div>
        <div className="series-lib-progress">
          <div className="series-lib-progress-label">
            <span>{ch?.name}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>
              {r.size} GB
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              marginTop: 4,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {r.air} · {r.duration}分
          </div>
        </div>
        <div className="series-lib-footer">
          <StateTag state={r.state} />
          <span style={{ flex: 1 }} />
          {handleDelete && (
            <button
              className="btn danger"
              style={{ fontSize: 10.5, padding: '3px 8px' }}
              onClick={handleDelete}
              title="録画ファイルごと削除"
            >
              削除
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface MovieLibCardProps {
  m: MovieListEntry;
  channels: Channel[];
  onDeleted?: (id: string) => void;
  onOpen?: () => void;
}

const MovieLibCard = ({ m, channels, onDeleted, onOpen }: MovieLibCardProps) => {
  const ch = channels.find((c) => c.id === m.r.ch);
  const handleDelete = makeDeleteHandler({ id: m.r.id, title: m.tvdb.title }, onDeleted);
  // Fall back to the recording's own duration when TVDB /search hit lacks
  // runtime (0). Rating/director may also be empty — omit rather than show "★ 0".
  const runtime = m.tvdb.runtime > 0 ? m.tvdb.runtime : m.r.duration;
  const subParts = [m.tvdb.titleEn, m.tvdb.year > 0 ? String(m.tvdb.year) : null].filter(Boolean);
  const statParts = [
    m.tvdb.rating > 0 ? `★ ${m.tvdb.rating}` : null,
    `${runtime}分`,
  ].filter(Boolean);
  return (
    <div className={`series-lib-card${onOpen ? ' clickable' : ''}`} onClick={onOpen}>
      <div className="lib-card-kind">
        <span className="kind-tag movie">映画</span>
      </div>
      <Poster seed={m.tvdb.slug} label={m.tvdb.titleEn} size="xl" poster={m.tvdb.poster} />
      <div className="series-lib-meta">
        <div className="series-lib-title">{m.tvdb.title}</div>
        <div className="series-lib-sub">{subParts.join(' · ')}</div>
        <div className="series-lib-progress">
          <div className="series-lib-progress-label">
            <span>{m.tvdb.director ? `${m.tvdb.director} 監督` : '監督情報なし'}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>
              {m.r.size} GB
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              marginTop: 4,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {statParts.join(' · ')}
          </div>
        </div>
        <div className="series-lib-footer">
          <StateTag state={m.r.state} />
          <span style={{ color: 'var(--fg-subtle)', fontSize: 10.5 }}>
            {ch?.name}で放送
          </span>
          {handleDelete && (
            <button
              className="btn danger"
              style={{ fontSize: 10.5, padding: '3px 8px', marginLeft: 'auto' }}
              onClick={handleDelete}
              title="録画ファイルごと削除"
            >
              削除
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface SeriesLibRowProps {
  s: SeriesListEntry;
  onOpen: () => void;
}

const SeriesLibRow = ({ s, onOpen }: SeriesLibRowProps) => {
  const counts = seriesCounts(s.tvdb, s.recorded);
  const totalSize = s.recorded.reduce((a, e) => a + e.size, 0).toFixed(1);
  return (
    <div className="res-row clickable" onClick={onOpen}>
      <div>
        <span className="kind-tag tvdb">シリーズ</span>
      </div>
      <div className="res-prog">
        <div className="res-title">{s.tvdb.title}</div>
        <div className="res-sub">{s.tvdb.titleEn}</div>
      </div>
      <div className="res-ch">{s.tvdb.network || '—'}</div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--fg)',
        }}
      >
        {s.recorded.length}
        {!counts.partial && (
          <>
            {' '}
            <span style={{ color: 'var(--fg-subtle)', fontSize: 10 }}>
              / {counts.currentEp}話
            </span>
          </>
        )}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--fg-muted)',
        }}
      >
        {totalSize} GB
      </div>
      <div>
        {s.rule ? (
          <span
            className={`series-lib-status ${s.rule.enabled ? 'on' : 'off'}`}
            style={{ fontSize: 10.5 }}
          >
            <span className="dot" /> {s.rule.enabled ? '自動' : '停止'}
          </span>
        ) : (
          <span className="series-lib-status manual" style={{ fontSize: 10.5 }} title="ルール登録なし">
            <span className="dot" /> 手動
          </span>
        )}
      </div>
    </div>
  );
};

interface RecordingLibRowProps {
  r: Recording;
  channels: Channel[];
  onDeleted?: (id: string) => void;
  onOpen?: (r: Recording) => void;
}

const RecordingLibRow = ({ r, channels, onDeleted, onOpen }: RecordingLibRowProps) => {
  const ch = channels.find((c) => c.id === r.ch);
  const handleDelete = makeDeleteHandler(r, onDeleted);
  return (
    <div
      className={`res-row ${onOpen ? 'clickable' : ''}`}
      onClick={onOpen ? () => onOpen(r) : undefined}
    >
      <div>
        <span className="kind-tag manual">録画物</span>
      </div>
      <div className="res-prog">
        <div className="res-title">{r.title}</div>
        <div className="res-sub">—</div>
      </div>
      <div className="res-ch">
        <span className="res-ch-num">{ch?.number}</span>
        {ch?.name}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--fg-muted)',
        }}
      >
        {r.air.split(' ')[0].split('/').slice(1).join('/')}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--fg-muted)',
        }}
      >
        {r.size} GB
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <StateTag state={r.state} />
        {handleDelete && (
          <button
            className="btn danger"
            style={{ fontSize: 10.5, padding: '2px 6px' }}
            onClick={handleDelete}
            title="録画ファイルごと削除"
          >
            削除
          </button>
        )}
      </div>
    </div>
  );
};

interface MovieLibRowProps {
  m: MovieListEntry;
  channels: Channel[];
  onDeleted?: (id: string) => void;
  onOpen?: () => void;
}

const MovieLibRow = ({ m, channels, onDeleted, onOpen }: MovieLibRowProps) => {
  const ch = channels.find((c) => c.id === m.r.ch);
  const handleDelete = makeDeleteHandler({ id: m.r.id, title: m.tvdb.title }, onDeleted);
  const subParts = [
    m.tvdb.titleEn,
    m.tvdb.year > 0 ? String(m.tvdb.year) : null,
    m.tvdb.director || null,
  ].filter(Boolean);
  return (
    <div className={`res-row${onOpen ? ' clickable' : ''}`} onClick={onOpen}>
      <div>
        <span className="kind-tag movie">映画</span>
      </div>
      <div className="res-prog">
        <div className="res-title">{m.tvdb.title}</div>
        <div className="res-sub">{subParts.join(' · ')}</div>
      </div>
      <div className="res-ch">
        <span className="res-ch-num">{ch?.number}</span>
        {ch?.name}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--fg-muted)',
        }}
      >
        {m.r.air.split(' ')[0].split('/').slice(1).join('/')}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--fg-muted)',
        }}
      >
        {m.r.size} GB
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <StateTag state={m.r.state} />
        {handleDelete && (
          <button
            className="btn danger"
            style={{ fontSize: 10.5, padding: '2px 6px' }}
            onClick={handleDelete}
            title="録画ファイルごと削除"
          >
            削除
          </button>
        )}
      </div>
    </div>
  );
};

interface MovieDetailProps {
  m: MovieListEntry;
  channels: Channel[];
  onBack: () => void;
  onDeleted?: (id: string) => void;
}

const MovieDetail = ({ m, channels, onBack, onDeleted }: MovieDetailProps) => {
  const ch = channels.find((c) => c.id === m.r.ch);
  const runtime = m.tvdb.runtime > 0 ? m.tvdb.runtime : m.r.duration;
  const handleDelete = makeDeleteHandler({ id: m.r.id, title: m.tvdb.title }, (id) => {
    onDeleted?.(id);
    onBack();
  });
  return (
    <div className="page">
      <div className="series-detail-hero">
        <Poster seed={m.tvdb.slug} label={m.tvdb.titleEn} size="xl" poster={m.tvdb.poster} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
            TVDB #{m.tvdb.id}
          </div>
          <h1 style={{ margin: '6px 0 4px', fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {m.tvdb.title}
          </h1>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            {m.tvdb.titleEn}
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 12, fontSize: 12, color: 'var(--fg-muted)' }}>
            {m.tvdb.year > 0 && <span><strong style={{ color: 'var(--fg)' }}>{m.tvdb.year}年</strong></span>}
            {m.tvdb.director && <span>{m.tvdb.director} 監督</span>}
            {runtime > 0 && <span>{runtime}分</span>}
            {m.tvdb.rating > 0 && <span>★ {m.tvdb.rating}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
            <button className="btn" onClick={onBack}>← 戻る</button>
            {handleDelete && (
              <button className="btn danger" onClick={handleDelete}>削除</button>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          録画情報
        </div>
        <div className="res-table" style={{ borderRadius: 8, overflow: 'hidden' }}>
          <div className="res-row" style={{ cursor: 'default' }}>
            <div><span className="kind-tag movie">映画</span></div>
            <div className="res-prog">
              <div className="res-title">{m.r.title}</div>
              <div className="res-sub">{ch?.name ?? m.r.ch}</div>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-muted)' }}>
              {m.r.air}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-muted)' }}>
              {m.r.size} GB
            </div>
            <div><StateTag state={m.r.state} /></div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface SeriesDetailProps {
  series: SeriesListEntry;
  onBack: () => void;
  toggleRule: (id: number) => void;
}

const SeriesDetail = ({ series: s, onBack: _onBack, toggleRule }: SeriesDetailProps) => {
  void _onBack;
  const counts = seriesCounts(s.tvdb, s.recorded);
  const latestRecordedSeason = Math.max(0, ...s.recorded.map((e) => e.season ?? 0));
  const [season, setSeason] = useState<number>(latestRecordedSeason || counts.currentSeason || 1);
  const recordedInSeason = s.recorded
    .filter((e) => e.season === season)
    .sort((a, b) => (b.ep ?? 0) - (a.ep ?? 0));
  const seasonsSet = new Set<number>(
    s.recorded.map((e) => e.season).filter((n): n is number => n != null)
  );
  if (seasonsSet.size === 0 && counts.currentSeason > 0) seasonsSet.add(counts.currentSeason);
  const seasons = Array.from(seasonsSet).sort((a, b) => b - a);
  if (seasons.length === 0) seasons.push(1);

  return (
    <div className="page">
      <div className="series-detail-hero">
        <Poster seed={s.tvdb.slug} label={s.tvdb.titleEn} size="xl" poster={s.tvdb.poster} />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--fg-subtle)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            TVDB #{s.tvdb.id}
          </div>
          <h1
            style={{
              margin: '6px 0 4px',
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            {s.tvdb.title}
          </h1>
          <div
            style={{
              fontSize: 13,
              color: 'var(--fg-muted)',
              fontStyle: 'italic',
            }}
          >
            {s.tvdb.titleEn}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 14,
              marginTop: 12,
              fontSize: 12,
              color: 'var(--fg-muted)',
            }}
          >
            {s.tvdb.year > 0 && (
              <span>
                <strong style={{ color: 'var(--fg)' }}>{s.tvdb.year}年</strong>〜
              </span>
            )}
            {s.tvdb.network && <span>{s.tvdb.network}</span>}
            <span>
              {counts.partial
                ? `${s.recorded.length}話録画済 (詳細未取得)`
                : `${counts.totalSeasons}シーズン / 全${counts.totalEps}話`}
            </span>
            <span
              style={{
                color:
                  s.tvdb.status === 'continuing'
                    ? 'var(--ok)'
                    : 'var(--fg-subtle)',
              }}
            >
              ● {s.tvdb.status === 'continuing' ? '放送中' : '終了'}
            </span>
          </div>
          <div
            style={{
              marginTop: 16,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            {s.rule ? (
              <button className="btn" onClick={() => toggleRule(s.rule!.id)}>
                {s.rule.enabled ? '自動録画を停止' : '自動録画を再開'}
              </button>
            ) : (
              <span
                style={{ fontSize: 12, color: 'var(--fg-muted)' }}
                title="自動録画ルールは未登録。発見タブから追加できます"
              >
                ルール未登録 (手動録画)
              </span>
            )}
            <button className="btn">設定</button>
            <span style={{ flex: 1 }} />
            {s.rule ? (
              <span
                className={`series-lib-status ${s.rule.enabled ? 'on' : 'off'}`}
              >
                <span className="dot" /> {s.rule.enabled ? '自動録画中' : '停止中'}
              </span>
            ) : (
              <span className="series-lib-status manual">
                <span className="dot" /> 手動録画
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Season tabs */}
      <div className="season-tabs">
        {seasons.map((n) => {
          const count = s.recorded.filter((e) => e.season === n).length;
          return (
            <button
              key={n}
              className={`season-tab ${n === season ? 'active' : ''}`}
              onClick={() => setSeason(n)}
            >
              シーズン {n}
              {count > 0 && <span className="season-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {recordedInSeason.length === 0 ? (
        <EmptyState
          icon="disk"
          title={`シーズン${season} はまだ録画がありません`}
          desc="放送されたら自動で録画されます。"
        />
      ) : (
        <div className="ep-list">
          {recordedInSeason.map((e) => (
            <div key={e.id} className="ep-row">
              <div className="ep-num">
                S{String(e.season ?? 0).padStart(2, '0')}
                <span>·</span>E{String(e.ep ?? 0).padStart(2, '0')}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ep-title">
                  {e.epTitle || '(タイトルなし)'}
                  {e.new && (
                    <span className="mini-ep-badge" style={{ marginLeft: 8 }}>
                      NEW
                    </span>
                  )}
                  <StateTag state={e.state} />
                </div>
                <div className="ep-sub">
                  {e.air} · {e.duration}分
                </div>
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--fg-muted)',
                  minWidth: 50,
                  textAlign: 'right',
                }}
              >
                {e.size} GB
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============ 予約・状態 (Reserves - single unified table) ============
// Post-R0 a single recording row spans the lifecycle: 予約 → 録画中 →
// エンコード中 → (ready=ライブラリへ移動). Library 表示側には state='ready'
// だけ、ここは state='ready' 以外 (+ failed/conflict) を扱う。旧 reserve/
// recorded の fuzzy-join バグは根本的に存在しなくなった。
type ReserveStatus =
  | 'recording'
  | 'encoding'
  | 'upcoming'
  | 'conflict'
  | 'failed'
  | 'done';

interface StatusBadgeProps {
  status: ReserveStatus;
  progress?: number | null;
}

const StatusBadge = ({ status, progress }: StatusBadgeProps) => {
  const cfgMap: Record<ReserveStatus, { cls: string; label: string; dot: boolean }> = {
    recording: { cls: 'rec', label: '録画中', dot: true },
    encoding: { cls: 'enc', label: 'エンコード中', dot: true },
    upcoming: { cls: 'up', label: '予約済', dot: false },
    conflict: { cls: 'con', label: '競合', dot: false },
    failed: { cls: 'con', label: '失敗', dot: false },
    done: { cls: 'done', label: '完了', dot: false },
  };
  const cfg = cfgMap[status] || { cls: 'up', label: status, dot: false };
  return (
    <span className={`status-badge ${cfg.cls}`}>
      {cfg.dot && <span className="pulse-dot" />}
      {cfg.label}
      {progress != null && (
        <span className="status-pct">{Math.round(progress * 100)}%</span>
      )}
    </span>
  );
};

type ReserveKind = 'series' | 'rule' | 'manual';
type ReserveFilter = 'all' | ReserveStatus;

interface ReserveRow {
  key: string;
  status: ReserveStatus;
  progress: number | null;
  time: string;
  sub: string;
  title: string;
  epTitle: string | null;
  ch: Channel | undefined;
  kind: ReserveKind;
  duration: number;
  action: string;
  onAction?: () => void;
  prog?: Program;
  /** Raw recording behind this row — used by the edit modal so we can seed
   *  form fields with the current priority/quality/margins. */
  recording: ApiRecording;
}

export interface ReservesPageProps {
  /** Unified recording rows with state != 'ready' (i.e. scheduled, in-
   *  flight, conflict or failed). Filtered client-side by the parent from
   *  the /recordings endpoint. */
  recordings: ApiRecording[];
  programs: Program[];
  onCancel: (p: Program) => void;
  /** Stop a live recording. Triggers POST /recordings/:id/stop which
   *  finalizes the .part file → .ts and transitions the row to encoding.
   *  Wired from App.tsx's handleStopRecording. */
  onStop?: (recordingId: string) => void;
  /** PATCH /recordings/:id — update priority/quality/keepRaw/margins on a
   *  scheduled recording. Wired from App.tsx. */
  onUpdate?: (recordingId: string, patch: ApiUpdateRecording) => Promise<void>;
  /** Re-fetch recordings. Triggered by the 1s polling effect while any row
   *  is live-recording/encoding. */
  onPollRefresh?: () => Promise<void>;
  rules: Rule[];
  channels: Channel[];
  tvdb: Record<string, TvdbEntry>;
}

export const ReservesPage = ({
  recordings,
  programs,
  onCancel,
  onStop,
  onUpdate,
  onPollRefresh,
  rules,
  channels,
  tvdb,
}: ReservesPageProps) => {
  const [filter, setFilter] = useState<ReserveFilter>('all');
  const [editing, setEditing] = useState<ApiRecording | null>(null);

  // 1s polling while anything is actively recording or encoding. Post-R0
  // a single `state` field tells us the full story — no more cross-joining
  // reserves + recorded. Polling pauses as soon as the condition goes
  // false so idle pages don't hammer the API. 課題#27.
  const hasLiveActivity = recordings.some(
    (r) => r.state === 'recording' || r.state === 'encoding'
  );
  useEffect(() => {
    if (!hasLiveActivity || !onPollRefresh) return;
    const h = window.setInterval(() => {
      void onPollRefresh();
    }, 1000);
    return () => window.clearInterval(h);
  }, [hasLiveActivity, onPollRefresh]);

  const programById = new Map(programs.map((p) => [progId(p), p]));

  const meta = (p: Program): { tvdb: TvdbEntry | null; rule: Rule | undefined } => {
    const tvdbEntry = p.series ? tvdb[p.series] ?? null : null;
    const rule = rules.find(
      (r) =>
        r.channels.includes(p.ch) &&
        p.title.includes(r.keyword.split(' ')[0])
    );
    return { tvdb: tvdbEntry, rule };
  };

  // Single switch on r.state — the unified Recording row carries the whole
  // lifecycle so the old "promote recorded.state up to reserve.state" fuzzy
  // join is gone. 'ready' rows are filtered out upstream (they belong to
  // the Library page).
  const reserveStatus = (r: ApiRecording): ReserveStatus | null => {
    switch (r.state) {
      case 'scheduled': return 'upcoming';
      case 'recording': return 'recording';
      case 'encoding':  return 'encoding';
      case 'ready':     return 'done';
      case 'failed':    return 'failed';
      case 'conflict':  return 'conflict';
    }
  };

  const sourceKind = (r: ApiRecording): ReserveKind => {
    if (r.source?.kind === 'series') return 'series';
    if (r.source?.kind === 'rule') return 'rule';
    return 'manual';
  };

  // Build row list — exactly one row per recording.
  const rows: ReserveRow[] = [];
  recordings.forEach((r) => {
    const status = reserveStatus(r);
    if (!status) return;
    const prog = programById.get(r.programId);
    const ch =
      channels.find((c) => c.id === r.ch) ??
      (prog ? channels.find((c) => c.id === prog.ch) : undefined);
    const startHHMM = prog?.start ?? r.startAt.slice(11, 16);
    const startMin = prog ? toMin(prog.start) : toMin(startHHMM);
    const endMin = prog
      ? toMin(prog.end)
      : toMin(r.endAt.slice(11, 16));
    const total = Math.max(1, endMin - startMin);
    const elapsed = Math.max(0, Math.min(total, MOCK_NOW_MIN - startMin));
    const m = prog ? meta(prog) : { tvdb: null, rule: undefined };
    const epTitle =
      m.tvdb && m.tvdb.type === 'series'
        ? `S${m.tvdb.currentSeason}E${m.tvdb.currentEp}`
        : null;

    let progress: number | null = null;
    let sub: string;
    let action: string;
    let onAction: (() => void) | undefined;
    switch (status) {
      case 'recording':
        progress = elapsed / total;
        sub = `残り${Math.max(0, total - elapsed)}分`;
        action = '停止';
        // onStop は App.tsx の handleStopRecording に接続される。録画中の
        // 行はここが唯一の停止ボタンなので、null 時は disabled 表示 (後段で
        // ガード)。未接続だと 「押しても何も起きない」課題が再発するので
        // 明示的に onAction を設定。
        onAction = onStop ? () => onStop(r.id) : undefined;
        break;
      case 'encoding': {
        // R0: encodeProgress is on the Recording row directly — single
        // source of truth, no more recorded-table cross-lookup.
        const pct = r.encodeProgress ?? 0;
        progress = pct;
        sub = `エンコード ${Math.round(pct * 100)}%`;
        action = '—';
        break;
      }
      case 'conflict':
        sub = '競合 (他の予約と重複)';
        action = '取消';
        onAction = prog ? () => onCancel(prog) : undefined;
        break;
      case 'failed':
        sub = '失敗 (エンコード etc.)';
        action = '取消';
        onAction = prog ? () => onCancel(prog) : undefined;
        break;
      case 'done':
        sub = '完了';
        action = '取消';
        onAction = prog ? () => onCancel(prog) : undefined;
        break;
      default: // upcoming
        sub =
          startMin < MOCK_NOW_MIN + 180 ? 'まもなく' : '本日';
        action = '取消';
        onAction = prog ? () => onCancel(prog) : undefined;
        break;
    }

    rows.push({
      key: 'rv-' + r.id,
      status,
      progress,
      time: startHHMM,
      sub,
      title: r.title,
      epTitle,
      ch,
      kind: sourceKind(r),
      duration: total,
      action,
      onAction,
      prog,
      recording: r,
    });
  });

  // Sort: active states first, then terminal states (done/failed) last.
  const order: Record<string, number> = {
    recording: 0,
    encoding: 1,
    upcoming: 2,
    conflict: 3,
    failed: 4,
    done: 5,
  };
  rows.sort(
    (a, b) =>
      (order[a.status] ?? 99) - (order[b.status] ?? 99) ||
      a.time.localeCompare(b.time)
  );

  const filtered = rows.filter((r) => filter === 'all' || r.status === filter);
  const counts = {
    recording: rows.filter((r) => r.status === 'recording').length,
    encoding: rows.filter((r) => r.status === 'encoding').length,
    upcoming: rows.filter((r) => r.status === 'upcoming').length,
    done: rows.filter((r) => r.status === 'done').length,
    failed: rows.filter((r) => r.status === 'failed').length,
  };

  return (
    <div className="page">
      <PageHead title="予約一覧" />

      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 18,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <StatPill label="録画中" value={counts.recording} tone="rec" />
        <StatPill label="エンコード" value={counts.encoding} />
        <StatPill label="予約" value={counts.upcoming} tone="accent" />
        <StatPill label="完了" value={counts.done} />
        {counts.failed > 0 && <StatPill label="失敗" value={counts.failed} />}
        <div style={{ flex: 1 }} />
        <div className="seg-sm">
          <button
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >
            すべて
          </button>
          <button
            className={filter === 'recording' ? 'active' : ''}
            onClick={() => setFilter('recording')}
          >
            録画中
          </button>
          <button
            className={filter === 'encoding' ? 'active' : ''}
            onClick={() => setFilter('encoding')}
          >
            エンコード
          </button>
          <button
            className={filter === 'upcoming' ? 'active' : ''}
            onClick={() => setFilter('upcoming')}
          >
            予約
          </button>
          <button
            className={filter === 'done' ? 'active' : ''}
            onClick={() => setFilter('done')}
          >
            完了
          </button>
          <button
            className={filter === 'failed' ? 'active' : ''}
            onClick={() => setFilter('failed')}
          >
            失敗
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="該当する予約がありません"
          desc="番組表から番組を選んで予約できます。"
        />
      ) : (
        <div className="res-table reserves">
          <div className="res-table-head">
            <div>状態</div>
            <div>開始</div>
            <div>番組</div>
            <div>チャンネル</div>
            <div>種別</div>
            <div>長さ</div>
            <div></div>
          </div>
          {filtered.map((r) => {
            // Only future-scheduled recordings are editable. Recording /
            // encoding / done / failed rows stay read-only because changing
            // priority/margins mid-flight has no meaning for an already-
            // running pipeline. 課題#3 / U2.
            const editable = r.recording.state === 'scheduled' && !!onUpdate;
            return (
            <div
              key={r.key}
              className={`res-row res-row-${r.status}${editable ? ' clickable' : ''}`}
              onClick={
                editable
                  ? () => setEditing(r.recording)
                  : undefined
              }
              style={editable ? { cursor: 'pointer' } : undefined}
            >
              <div>
                <StatusBadge status={r.status} progress={r.progress} />
              </div>
              <div className="res-when">
                <div className="res-time">{r.time}</div>
                <div className="res-date">{r.sub}</div>
              </div>
              <div className="res-prog">
                <div className="res-title">{r.title}</div>
                <div className="res-sub">
                  {r.epTitle && (
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--accent)',
                        marginRight: 6,
                      }}
                    >
                      {r.epTitle}
                    </span>
                  )}
                  {r.prog && (
                    <>
                      <span
                        className="g-dot"
                        style={{ background: r.prog.genre.dot }}
                      />
                      {r.prog.genre.label}
                    </>
                  )}
                </div>
                {r.progress != null && (
                  <div
                    className={`status-bar ${
                      r.status === 'recording' ? 'rec' : 'enc'
                    }`}
                    style={{ marginTop: 6 }}
                  >
                    <div style={{ width: `${r.progress * 100}%` }} />
                  </div>
                )}
              </div>
              <div className="res-ch">
                <span className="res-ch-num">{r.ch?.number}</span>
                {r.ch?.name}
              </div>
              <div>
                {r.kind === 'series' ? (
                  <span className="kind-tag tvdb">シリーズ</span>
                ) : r.kind === 'rule' ? (
                  <span className="kind-tag rule">ルール</span>
                ) : (
                  <span className="kind-tag manual">単発</span>
                )}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--fg-muted)',
                }}
              >
                {r.duration}分
              </div>
              <div>
                <button
                  className={`btn btn-sm ${
                    r.status === 'recording' ? 'danger' : 'ghost'
                  }`}
                  onClick={(e) => {
                    // Stop bubbling so the action button doesn't also
                    // open the edit modal on clickable rows.
                    e.stopPropagation();
                    r.onAction?.();
                  }}
                  disabled={!r.onAction}
                  style={!r.onAction ? { opacity: 0.4, cursor: 'default' } : undefined}
                >
                  {r.action}
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {editing && onUpdate && (
        <ReserveEditModal
          recording={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await onUpdate(editing.id, patch);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
};

// ---------- Recording edit modal ----------
// Inline so Pages.tsx stays self-contained for the edit flow. Exposed fields
// mirror ReserveNewModal (Modal.tsx) — 優先度 / 品質 / TSを残す / 前後マージン.
// Only rendered for state='scheduled' recordings (enforced by the caller).
interface ReserveEditModalProps {
  recording: ApiRecording;
  onClose: () => void;
  onSave: (patch: ApiUpdateRecording) => Promise<void>;
}

type EditPriority = 'high' | 'medium' | 'low';
type EditQuality = '1080i' | '720p';

const ReserveEditModal = ({ recording, onClose, onSave }: ReserveEditModalProps) => {
  const [priority, setPriority] = useState<EditPriority>(
    (recording.priority as EditPriority) ?? 'medium'
  );
  const [quality, setQuality] = useState<EditQuality>(
    (recording.quality as EditQuality) ?? '1080i'
  );
  const [keepRaw, setKeepRaw] = useState<boolean>(recording.keepRaw ?? false);
  const [marginPre, setMarginPre] = useState<number>(recording.marginPre ?? 0);
  const [marginPost, setMarginPost] = useState<number>(recording.marginPost ?? 30);
  const [saving, setSaving] = useState(false);

  const doSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({ priority, quality, keepRaw, marginPre, marginPost });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e: ReactMouseEvent<HTMLDivElement>) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title-row">
            <div className="modal-title">予約を編集</div>
          </div>
          <div className="modal-channel-line">
            <span>{recording.title}</span>
          </div>
        </div>
        <div className="modal-body">
          <div className="opt-row">
            <label className="opt-label">
              <span className="opt-label-text">優先度</span>
              <div className="seg-sm">
                {(['high', 'medium', 'low'] as const).map((p) => (
                  <button
                    key={p}
                    className={priority === p ? 'active' : ''}
                    onClick={() => setPriority(p)}
                  >
                    {p === 'high' ? '高' : p === 'medium' ? '中' : '低'}
                  </button>
                ))}
              </div>
            </label>
            <label className="opt-label">
              <span className="opt-label-text">品質</span>
              <div className="seg-sm">
                {(['1080i', '720p'] as const).map((q) => (
                  <button
                    key={q}
                    className={quality === q ? 'active' : ''}
                    onClick={() => setQuality(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </label>
            <label className="opt-label">
              <span className="opt-label-text">TSを残す</span>
              <div className="seg-sm">
                <button
                  className={!keepRaw ? 'active' : ''}
                  onClick={() => setKeepRaw(false)}
                >
                  削除
                </button>
                <button
                  className={keepRaw ? 'active' : ''}
                  onClick={() => setKeepRaw(true)}
                >
                  保存
                </button>
              </div>
            </label>
          </div>
          <div className="opt-row">
            <label className="opt-label">
              <span className="opt-label-text">前マージン (秒)</span>
              <input
                className="control-sm"
                type="number"
                value={marginPre}
                min={0}
                onChange={(e) => setMarginPre(Math.max(0, Number(e.target.value) || 0))}
                style={{ width: 80, fontFamily: 'var(--font-mono)' }}
              />
            </label>
            <label className="opt-label">
              <span className="opt-label-text">後マージン (秒)</span>
              <input
                className="control-sm"
                type="number"
                value={marginPost}
                min={0}
                onChange={(e) => setMarginPost(Math.max(0, Number(e.target.value) || 0))}
                style={{ width: 80, fontFamily: 'var(--font-mono)' }}
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn ghost" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button
              className="btn"
              onClick={() => void doSave()}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============ 設定 ============
interface SettingsSectionProps {
  title: string;
  desc?: string;
  children: ReactNode;
}

const SettingsSection = ({ title, desc, children }: SettingsSectionProps) => (
  <div style={{ marginBottom: 26 }}>
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
        {title}
      </div>
      {desc && (
        <div
          style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}
        >
          {desc}
        </div>
      )}
    </div>
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-elev)',
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  </div>
);

interface SettingRowProps {
  label: string;
  value: ReactNode;
  action: string;
  mono?: boolean;
}

const SettingRow = ({ label, value, action, mono }: SettingRowProps) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '180px 1fr auto',
      gap: 14,
      alignItems: 'center',
      padding: '11px 14px',
      borderBottom: '1px solid var(--border)',
    }}
  >
    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{label}</div>
    <div
      style={{
        fontSize: 12,
        color: 'var(--fg)',
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
      }}
    >
      {value}
    </div>
    <button className="btn btn-sm ghost">{action}</button>
  </div>
);

export interface SettingsPageProps {
  /** Optional toast hook. Maintenance buttons call this with a human-readable
   *  message so the parent can show the same toast UI as the rest of the app. */
  pushToast?: (msg: string, kind?: 'ok' | 'err') => void;
}

// Manual-trigger counterparts to the pg-boss crons. Lives here rather than in
// the parent because it's a self-contained UI block — kicks the endpoints,
// shows a pending state, then reports back via pushToast.
interface MaintenanceSectionProps {
  pushToast?: (msg: string, kind?: 'ok' | 'err') => void;
}

const MaintenanceSection = ({ pushToast }: MaintenanceSectionProps) => {
  const [refreshing, setRefreshing] = useState(false);
  const [expanding, setExpanding] = useState(false);

  const handleRefreshEpg = async () => {
    setRefreshing(true);
    try {
      const r = await api.admin.refreshEpg();
      pushToast?.(
        `EPGを更新しました: ${r.programsUpserted}番組 / TVDB解決 ${r.tvdbResolved} (未解決 ${r.tvdbMissed})`
      );
    } catch (e) {
      pushToast?.(`EPG更新失敗: ${(e as Error).message}`, 'err');
    } finally {
      setRefreshing(false);
    }
  };

  const handleExpandRules = async () => {
    setExpanding(true);
    try {
      const r = await api.admin.expandRules();
      pushToast?.(
        `ルールを展開しました: マッチ${r.matchedPrograms}件 / 予約${r.createdRecordings}件 `
        + `(重複${r.conflicts.duplicate} / チューナー不足${r.conflicts.tunerFull})`
      );
    } catch (e) {
      pushToast?.(`ルール展開失敗: ${(e as Error).message}`, 'err');
    } finally {
      setExpanding(false);
    }
  };

  return (
    <SettingsSection
      title="メンテナンス"
      desc="通常は自動実行されるジョブを、その場で手動トリガできます。"
    >
      <MaintenanceRow
        label="EPGを今すぐ更新"
        desc="Mirakurunから番組表を取り直し、TVDBと突き合わせます。"
        action={refreshing ? '更新中…' : 'EPGを今すぐ更新'}
        onClick={() => void handleRefreshEpg()}
        disabled={refreshing}
      />
      <MaintenanceRow
        label="ルールを今すぐ展開"
        desc="有効な全ルールを走査し、マッチする未予約の番組を予約化します。"
        action={expanding ? '展開中…' : 'ルールを今すぐ展開'}
        onClick={() => void handleExpandRules()}
        disabled={expanding}
      />
    </SettingsSection>
  );
};

interface MaintenanceRowProps {
  label: string;
  desc: string;
  action: string;
  onClick: () => void;
  disabled?: boolean;
}

const MaintenanceRow = ({ label, desc, action, onClick, disabled }: MaintenanceRowProps) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: 14,
      alignItems: 'center',
      padding: '11px 14px',
      borderBottom: '1px solid var(--border)',
    }}
  >
    <div>
      <div style={{ fontSize: 12, color: 'var(--fg)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>{desc}</div>
    </div>
    <button
      className="btn btn-sm"
      onClick={onClick}
      disabled={disabled}
      style={disabled ? { opacity: 0.6 } : undefined}
    >
      {action}
    </button>
  </div>
);

// -----------------------------------------------------------------
// Channel sources — lets the user register m3u IPTV playlists / Mirakurun
// endpoints. Registered rows drive the channels table: syncing walks each
// upstream and upserts one channel row per entry/service. The recorder then
// reads `channels.streamUrl` directly, so m3u and Mirakurun both work the
// same way from the recording pipeline's point of view.
// -----------------------------------------------------------------

interface ChannelSourcesSectionProps {
  pushToast?: (msg: string, kind?: 'ok' | 'err') => void;
}

const ChannelSourcesSection = ({ pushToast }: ChannelSourcesSectionProps) => {
  const [sources, setSources] = useState<ApiChannelSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [openDeviceId, setOpenDeviceId] = useState<number | null>(null);
  const openDevice = openDeviceId != null
    ? sources.find((s) => s.id === openDeviceId) ?? null
    : null;

  const load = async () => {
    try {
      const rows = await api.admin.channelSources.list();
      setSources(rows);
    } catch (e) {
      pushToast?.(`チャンネルソース取得失敗: ${(e as Error).message}`, 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleSync = async (id: number) => {
    setSyncingId(id);
    try {
      const res = await api.admin.channelSources.sync(id);
      if (res.error) {
        pushToast?.(`sync 失敗: ${res.error}`, 'err');
      } else {
        pushToast?.(`sync 完了: ${res.channelCount} チャンネル`);
      }
      await load();
    } catch (e) {
      pushToast?.(`sync 失敗: ${(e as Error).message}`, 'err');
    } finally {
      setSyncingId(null);
    }
  };

  const totalChannels = sources.reduce((s, r) => s + r.channelCount, 0);

  return (
    <>
      <div className="settings-section-head">
        <div>
          <div className="settings-section-title">デバイス</div>
          <div className="settings-section-desc">
            IPTV (m3u) と XMLTV 番組表で接続する HDHomeRun 互換デバイス。Mirakurun も同じルートで登録できます。
          </div>
        </div>
        <div className="settings-section-actions">
          {!loading && (
            <span className="settings-section-stat">
              <span className="stat-num">{sources.length}</span> デバイス
              <span className="stat-sep">·</span>
              <span className="stat-num">{totalChannels}</span> ch
            </span>
          )}
          <button className="btn btn-sm" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={12} />
            追加
          </button>
        </div>
      </div>

      <div className="src-table">
        <div className="src-row src-row-head">
          <div>名前</div>
          <div>モデル</div>
          <div>URL</div>
          <div>最終同期</div>
          <div>チャンネル</div>
          <div />
        </div>
        {loading && (
          <div className="src-empty">読み込み中…</div>
        )}
        {!loading && sources.length === 0 && (
          <div className="src-empty">
            まだ登録されているデバイスはありません。右上の「追加」から登録してください。
          </div>
        )}
        {sources.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`src-row clickable${s.lastError ? ' has-error' : ''}`}
            title={s.lastError ?? 'クリックでチャンネル一覧を開く'}
            onClick={() => setOpenDeviceId(s.id)}
          >
            <div className="src-name">
              {s.name}
              {s.lastError && <span className="src-error-dot" aria-label="エラー">●</span>}
            </div>
            <div className="src-kind">
              {s.model || s.friendlyName ? (
                <span className="kind-chip kind-iptv" title={s.friendlyName ?? undefined}>
                  {s.model ?? s.friendlyName}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>—</span>
              )}
            </div>
            <div className="src-url" title={s.url}>
              {s.url}
              {s.xmltvUrl && (
                <div
                  style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}
                  title={s.xmltvUrl}
                >
                  XMLTV: {s.xmltvUrl}
                </div>
              )}
            </div>
            <div className="src-sync">
              {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString('ja-JP') : '未同期'}
            </div>
            <div className="src-count">
              {s.channelCount} ch
              {s.tunerCount != null && (
                <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>
                  {s.tunerCount} チューナー
                </div>
              )}
            </div>
            <div className="src-chev"><Icon name="chevR" size={14} /></div>
          </button>
        ))}
      </div>

      {openDevice && (
        <DeviceDetailModal
          device={openDevice}
          syncing={syncingId === openDevice.id}
          onClose={() => setOpenDeviceId(null)}
          onSync={() => void handleSync(openDevice.id)}
          onDelete={async () => {
            const ok = window.confirm(`「${openDevice.name}」を削除しますか？ (登録済みチャンネルも削除されます)`);
            if (!ok) return;
            setOpenDeviceId(null);
            try {
              await api.admin.channelSources.remove(openDevice.id);
              await load();
              pushToast?.('削除しました');
            } catch (e) {
              pushToast?.(`削除失敗: ${(e as Error).message}`, 'err');
            }
          }}
          onToastError={(msg) => pushToast?.(msg, 'err')}
        />
      )}

      {addOpen && (
        <AddChannelSourceModal
          existingUrls={new Set(sources.map((s) => s.url))}
          onClose={() => setAddOpen(false)}
          onAdded={async () => {
            setAddOpen(false);
            await load();
            pushToast?.('チャンネルソースを追加しました');
          }}
          onError={(msg) => pushToast?.(msg, 'err')}
        />
      )}
    </>
  );
};

// ----- Add channel source modal ---------------------------------
interface AddChannelSourceModalProps {
  existingUrls: Set<string>;
  onClose: () => void;
  onAdded: () => Promise<void> | void;
  onError: (msg: string) => void;
}

const AddChannelSourceModal = ({ existingUrls, onClose, onAdded, onError }: AddChannelSourceModalProps) => {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [xmltvUrl, setXmltvUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [probe, setProbe] = useState<ApiProbeChannelSourceResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<ApiScannedDevice[] | null>(null);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number; pct: number } | null>(null);
  // Hold the active EventSource so the user (or cleanup) can abort mid-scan.
  const scanSourceRef = useRef<EventSource | null>(null);
  // Remember what URL produced the current probe so we don't spam the
  // backend while the user types. The blur handler will debounce off this.
  const lastProbedRef = useRef<string>('');
  // Also remember whether the user manually edited the XMLTV field — once
  // they do, we stop auto-filling it from probe results.
  const userEditedXmltvRef = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !submitting) onClose();
  };

  const canSubmit = name.trim().length > 0 && url.trim().length > 0 && !submitting;

  // Run the probe after user leaves the URL field. Best-effort: failures
  // just clear the probe state and let the user type XMLTV URL manually.
  const runProbe = async () => {
    const u = url.trim();
    if (!u || u === lastProbedRef.current) return;
    lastProbedRef.current = u;
    setProbing(true);
    try {
      const r = await api.admin.channelSources.probe(u);
      setProbe(r);
      if (!userEditedXmltvRef.current && r.suggestedXmltvUrl) {
        setXmltvUrl(r.suggestedXmltvUrl);
      }
      // Prefer the real discover.FriendlyName → Model → the kind heuristic,
      // so users get a meaningful default instead of typing anything.
      const inferredName = r.friendlyName ?? r.model ?? r.inferredKind;
      if (inferredName && !name.trim()) {
        setName(inferredName);
      }
    } catch {
      setProbe(null);
    } finally {
      setProbing(false);
    }
  };

  // Track which scan rows are currently being added so we can show per-row
  // spinners without locking the whole modal.
  const [addingUrl, setAddingUrl] = useState<string | null>(null);

  // Scan → click = add. We create the device directly with the discovered
  // kind / name / URLs; the user can rename after the fact from the list.
  const addFromScan = async (d: ApiScannedDevice) => {
    if (addingUrl) return;
    setAddingUrl(d.url);
    try {
      await api.admin.channelSources.create({
        name: d.friendlyName ?? d.model ?? d.label,
        kind: d.kind,
        url: d.url,
        xmltvUrl: d.kind === 'iptv' ? d.suggestedXmltvUrl ?? null : null,
      });
      stopScan();
      await onAdded();
    } catch (e) {
      onError(`追加失敗: ${(e as Error).message}`);
    } finally {
      setAddingUrl(null);
    }
  };


  const stopScan = () => {
    scanSourceRef.current?.close();
    scanSourceRef.current = null;
    setScanning(false);
  };

  // Stream the scan over SSE so devices pop in as the server finds them —
  // user sees the first match in a few seconds instead of waiting 25s for
  // the whole /24 to complete.
  const runScan = () => {
    if (scanning) {
      stopScan();
      return;
    }
    setScanning(true);
    setScanResults([]);
    setScanProgress({ done: 0, total: 0, pct: 0 });
    // Hand the server our browser-visible hostname as a subnet hint — when
    // the user accesses the app via a LAN IP this tells the scanner to also
    // probe that /24 (useful when the server lives in a Docker container
    // on a different subnet from the user's real devices).
    const hint = window.location.hostname;
    const qs = hint ? `?hint=${encodeURIComponent(hint)}` : '';
    const src = new EventSource(`/api/admin/channel-sources/scan-stream${qs}`);
    scanSourceRef.current = src;
    src.addEventListener('progress', (e) => {
      try {
        setScanProgress(JSON.parse((e as MessageEvent<string>).data));
      } catch {}
    });
    src.addEventListener('device', (e) => {
      try {
        const d = JSON.parse((e as MessageEvent<string>).data) as ApiScannedDevice;
        setScanResults((prev) => {
          if (!prev) return [d];
          if (prev.some((x) => x.url === d.url)) return prev;
          return [...prev, d];
        });
      } catch {}
    });
    src.addEventListener('done', () => stopScan());
    src.onerror = () => {
      // Server closed the stream or network dropped — treat as done.
      stopScan();
    };
  };

  // Auto-start a scan as soon as the modal opens — the user came here to add
  // a device, and the fastest path is "open → pick from scan results".
  // Also clean up on unmount so a fast close doesn't leak a streaming req.
  useEffect(() => {
    runScan();
    return () => {
      scanSourceRef.current?.close();
      scanSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual form is collapsed by default — surfaces only when scan finishes
  // empty or when the user explicitly asks for it.
  const [manualOpen, setManualOpen] = useState(false);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.admin.channelSources.create({
        name: name.trim(),
        kind: 'iptv',
        url: url.trim(),
        xmltvUrl: xmltvUrl.trim() || null,
      });
      await onAdded();
    } catch (e) {
      onError(`追加失敗: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropClick}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="デバイスを追加">
        <div className="modal-head">
          <div className="modal-title">デバイスを追加</div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
            IPTV (m3u) URL を入れると discover.json を自動チェックし、対応していれば XMLTV URL も推測して埋めます。Plex / Jellyfin と同様のパターンです。
          </div>
        </div>
        <div className="modal-body add-device-body">
          {/* Primary path: live scan results. The whole row is a click target
              that adds the device directly — no form, no confirmation. */}
          <div className="scan-panel">
            <div className="scan-panel-head">
              {scanning && <span className="scan-spinner" aria-hidden />}
              <span className="scan-panel-title">
                {scanning
                  ? 'ローカルネットワークを検索中'
                  : scanResults && scanResults.length > 0
                    ? `${scanResults.length} 件見つかりました`
                    : '検索結果'}
              </span>
            </div>

            <div className="scan-results">
              {scanResults && scanResults.length === 0 && !scanning && (
                <div className="scan-empty-row">
                  対応デバイスは見つかりませんでした。
                </div>
              )}
              {scanResults && scanResults.length === 0 && scanning && (
                <div className="scan-empty-row subtle">検索中…</div>
              )}
              {scanResults && scanResults.map((d) => {
                const busy = addingUrl === d.url;
                const already = existingUrls.has(d.url);
                return (
                  <button
                    key={d.url}
                    type="button"
                    className={`scan-result-body${busy ? ' busy' : ''}${already ? ' already' : ''}`}
                    onClick={() => void addFromScan(d)}
                    disabled={!!addingUrl || submitting || already}
                    aria-disabled={already}
                  >
                    <div className="scan-result-main">
                      <div className="scan-result-name">{d.friendlyName ?? d.label}</div>
                      <div className="scan-result-url" title={d.url}>{d.url}</div>
                    </div>
                    <div className="scan-result-meta">
                      {d.model && <span>{d.model}</span>}
                      {d.tunerCount != null && <span>{d.tunerCount}&nbsp;ch</span>}
                    </div>
                    <span className={`scan-result-add${already ? ' added' : ''}`}>
                      {already ? '登録済' : busy ? '追加中…' : '追加'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Manual fallback: hidden by default, revealed when the user taps
              "手動で入力" or edits a scan row. Keeps the primary flow quiet. */}
          <div className="manual-toggle-row">
            <button
              type="button"
              className="manual-toggle"
              onClick={() => setManualOpen((v) => !v)}
            >
              {manualOpen ? '手動入力を閉じる' : '手動で入力'}
            </button>
          </div>

          {manualOpen && (
            <div className="field-group">
              <label className="field">
                <span className="field-label">名前</span>
                <input
                  className="field-input"
                  placeholder="未入力なら検出結果から自動設定"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field-label">m3u / IPTV URL</span>
                <input
                  className="field-input mono"
                  placeholder="http://mirakurun:40772/api/iptv"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (e.target.value.trim() !== lastProbedRef.current) setProbe(null);
                  }}
                  onBlur={() => void runProbe()}
                />
                <span className={`field-hint${probe?.reachable ? ' ok' : ''}`}>
                  {probing && '検出中…'}
                  {!probing && probe && probe.reachable && (
                    <>
                      {probe.inferredKind ?? probe.friendlyName ?? 'HDHomeRun'} を検出
                      {probe.tunerCount != null && ` · ${probe.tunerCount} チューナー`}
                      {probe.model && ` · ${probe.model}`}
                    </>
                  )}
                  {!probing && probe && !probe.reachable && probe.inferredKind && (
                    <>{probe.inferredKind} 形式 · XMLTV URL を推測しました</>
                  )}
                </span>
              </label>

              <label className="field">
                <span className="field-label">
                  XMLTV 番組表 URL
                  <span className="field-optional">任意</span>
                </span>
                <input
                  className="field-input mono"
                  placeholder="http://mirakurun:40772/api/iptv/xmltv"
                  value={xmltvUrl}
                  onChange={(e) => {
                    userEditedXmltvRef.current = true;
                    setXmltvUrl(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSubmit) void submit();
                  }}
                />
              </label>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-sm ghost" onClick={onClose} disabled={submitting}>
            閉じる
          </button>
          <div className="spacer" />
          {manualOpen && (
            <button
              className="btn btn-sm"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {submitting ? '追加中…' : '手動で追加'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// -----------------------------------------------------------------
// GPU エンコード設定 (課題 #26 / R4).
//
// - Shows the cached probe (or "未実行") and a "GPU テスト実行" button that
//   re-runs the 8-encoder probe via POST /admin/gpu/probe.
// - When any encoder is available, enables the "GPU でエンコード" toggle + a
//   dropdown picking `preferred` from the available list.
// - Toggle / dropdown changes are persisted via PATCH /admin/gpu/settings.
// -----------------------------------------------------------------

interface GpuEncodeSectionProps {
  pushToast?: (msg: string, kind?: 'ok' | 'err') => void;
}

const GPU_ENCODERS: readonly ApiGpuEncoder[] = [
  'h264_nvenc', 'hevc_nvenc',
  'h264_vaapi', 'hevc_vaapi',
  'h264_qsv',   'hevc_qsv',
  'h264_videotoolbox', 'hevc_videotoolbox',
];

const ENCODER_LABELS: Record<ApiGpuEncoder, string> = {
  h264_nvenc: 'H.264 NVENC',
  hevc_nvenc: 'H.265 NVENC',
  h264_vaapi: 'H.264 VAAPI',
  hevc_vaapi: 'H.265 VAAPI',
  h264_qsv:   'H.264 QSV',
  hevc_qsv:   'H.265 QSV',
  h264_videotoolbox: 'H.264 VideoToolbox',
  hevc_videotoolbox: 'H.265 VideoToolbox',
};

const GpuEncodeSection = ({ pushToast }: GpuEncodeSectionProps) => {
  const [status, setStatus] = useState<ApiGpuStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.admin.gpu.status()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch((e) => { if (!cancelled) pushToast?.(`GPU状態取得失敗: ${(e as Error).message}`, 'err'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleProbe = async () => {
    setProbing(true);
    try {
      const result: ApiGpuProbeResult = await api.admin.gpu.probe();
      // Re-fetch status so `preferred` (auto-seeded server-side) is in sync.
      const next = await api.admin.gpu.status();
      setStatus(next);
      const n = result.available.length;
      pushToast?.(n > 0
        ? `GPU検出: ${n}種のエンコーダが利用可能`
        : 'GPUは検出されませんでした (CPUエンコードを継続)');
    } catch (e) {
      pushToast?.(`probe失敗: ${(e as Error).message}`, 'err');
    } finally {
      setProbing(false);
    }
  };

  const saveSettings = async (patch: { enabled?: boolean; preferred?: ApiGpuEncoder | null }) => {
    setSaving(true);
    try {
      const next = await api.admin.gpu.settings(patch);
      setStatus(next);
    } catch (e) {
      pushToast?.(`設定保存失敗: ${(e as Error).message}`, 'err');
    } finally {
      setSaving(false);
    }
  };

  const available = status?.lastProbe?.available ?? [];
  const details = status?.lastProbe?.details ?? null;
  const probedAt = status?.lastProbe?.probedAt ?? null;
  const hasAny = available.length > 0;

  return (
    <SettingsSection
      title="エンコード (GPU)"
      desc="ffmpeg でハードウェアエンコーダを検出し、録画のエンコードを GPU で処理します。"
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 14,
          alignItems: 'center',
          padding: '11px 14px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg)', fontWeight: 600 }}>
            現在の状態
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
            {loading ? '読み込み中…' : (
              probedAt
                ? `直近 probe: ${new Date(probedAt).toLocaleString('ja-JP')} / 利用可能: ${available.length}種`
                : 'probe 未実行 — 「GPU テスト実行」で検出してください'
            )}
          </div>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => void handleProbe()}
          disabled={probing || loading}
          style={probing || loading ? { opacity: 0.6 } : undefined}
        >
          {probing ? '検出中…' : 'GPU テスト実行'}
        </button>
      </div>

      {details && (
        <div
          style={{
            padding: '11px 14px',
            borderBottom: '1px solid var(--border)',
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: '6px 14px',
          }}
        >
          {GPU_ENCODERS.map((enc) => {
            const d = details[enc];
            const ok = d?.ok === true;
            return (
              <div
                key={enc}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11.5,
                  color: ok ? 'var(--fg)' : 'var(--fg-subtle)',
                }}
                title={!ok ? d?.error ?? 'unavailable' : 'available'}
              >
                <span style={{ color: ok ? '#2a9d5a' : '#c33', fontWeight: 700, width: 14 }}>
                  {ok ? '✓' : '✗'}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{ENCODER_LABELS[enc]}</span>
              </div>
            );
          })}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '180px 1fr auto',
          gap: 14,
          alignItems: 'center',
          padding: '11px 14px',
          borderBottom: '1px solid var(--border)',
          opacity: hasAny ? 1 : 0.55,
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>GPU でエンコード</div>
        <div style={{ fontSize: 12 }}>
          {hasAny
            ? (status?.enabled ? 'ON — 対応プリセットを自動で GPU 版へ昇格' : 'OFF — CPU プリセットを使用')
            : '利用可能なGPUエンコーダがありません'}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={status?.enabled === true}
            disabled={!hasAny || saving}
            onChange={(e) => void saveSettings({ enabled: e.target.checked })}
          />
          <span style={{ fontSize: 11 }}>有効</span>
        </label>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '180px 1fr auto',
          gap: 14,
          alignItems: 'center',
          padding: '11px 14px',
          opacity: hasAny ? 1 : 0.55,
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>優先エンコーダ</div>
        <div style={{ fontSize: 12 }}>
          <select
            className="control-sm"
            value={status?.preferred ?? ''}
            disabled={!hasAny || saving}
            onChange={(e) => {
              const v = e.target.value;
              void saveSettings({ preferred: v === '' ? null : (v as ApiGpuEncoder) });
            }}
          >
            <option value="">(未選択 — CPU プリセットを使用)</option>
            {available.map((enc) => (
              <option key={enc} value={enc}>{ENCODER_LABELS[enc]}</option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
          {saving ? '保存中…' : ''}
        </div>
      </div>
    </SettingsSection>
  );
};

// Settings tabs. Flat list rendered in a left rail — grouped by subtle
// dividers rather than headings so the nav stays quiet. Order follows the
// typical "setup → operate → maintain" flow.
type SettingsTabKey =
  | 'channels'
  | 'recording'
  | 'tvdb'
  | 'storage'
  | 'maintenance';

interface SettingsTabDef {
  key: SettingsTabKey;
  icon: IconName;
  label: string;
  group: 'input' | 'record' | 'system';
}

const SETTINGS_TABS: SettingsTabDef[] = [
  { key: 'channels',    icon: 'tv',        label: 'デバイス',         group: 'input' },
  { key: 'recording',   icon: 'rec',       label: '録画・エンコード', group: 'record' },
  { key: 'tvdb',        icon: 'link',      label: 'シリーズ連携',     group: 'record' },
  { key: 'storage',     icon: 'disk',      label: 'ストレージ',       group: 'record' },
  { key: 'maintenance', icon: 'lightning', label: 'メンテナンス',     group: 'system' },
];

const GROUP_LABELS: Record<SettingsTabDef['group'], string> = {
  input: '受信',
  record: '録画',
  system: 'システム',
};

const isSettingsTabKey = (v: string | null): v is SettingsTabKey =>
  !!v && SETTINGS_TABS.some((t) => t.key === v);

export const SettingsPage = ({ pushToast }: SettingsPageProps = {}) => {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const active: SettingsTabKey = isSettingsTabKey(raw) ? raw : 'channels';

  const setTab = (key: SettingsTabKey) => {
    const next = new URLSearchParams(params);
    if (key === 'channels') next.delete('tab');
    else next.set('tab', key);
    setParams(next, { replace: true });
  };

  // Render tabs with a group heading inserted before the first item of
  // each group. Keeps the nav structured without a wrapper element per group.
  const navItems: ReactNode[] = [];
  let lastGroup: SettingsTabDef['group'] | null = null;
  for (const tab of SETTINGS_TABS) {
    if (tab.group !== lastGroup) {
      navItems.push(
        <div key={`h-${tab.group}`} className="settings-nav-heading">
          {GROUP_LABELS[tab.group]}
        </div>
      );
      lastGroup = tab.group;
    }
    navItems.push(
      <button
        key={tab.key}
        type="button"
        data-tab={tab.key}
        className={`settings-nav-item ${tab.key === active ? 'active' : ''}`}
        onClick={() => setTab(tab.key)}
        aria-current={tab.key === active ? 'page' : undefined}
      >
        <Icon name={tab.icon} size={14} />
        <span>{tab.label}</span>
      </button>
    );
  }

  const handleNavKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const i = SETTINGS_TABS.findIndex((t) => t.key === active);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowDown') nextIdx = (i + 1) % SETTINGS_TABS.length;
    else if (e.key === 'ArrowUp') nextIdx = (i - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = SETTINGS_TABS.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const nextKey = SETTINGS_TABS[nextIdx].key;
    setTab(nextKey);
    // Focus the newly-active button so subsequent arrow presses keep flowing.
    // Rendering is synchronous after setParams, so the node exists by the next tick.
    requestAnimationFrame(() => {
      const el = e.currentTarget.querySelector<HTMLButtonElement>(
        `button[data-tab="${nextKey}"]`
      );
      el?.focus();
    });
  };

  return (
    <div className="page settings-page">
      <PageHead title="設定" />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="設定カテゴリ" onKeyDown={handleNavKey}>
          {navItems}
          <div className="settings-nav-heading">開発者</div>
          <a
            className="settings-nav-item"
            href={import.meta.env.VITE_USE_FIXTURES === '1' ? 'api-docs.html' : '/docs'}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: 'none' }}
          >
            <Icon name="link" size={14} />
            <span>API 仕様書</span>
          </a>
        </nav>
        <div key={active} className="settings-pane">
          {active === 'channels' && <ChannelSourcesSection pushToast={pushToast} />}

          {active === 'recording' && (
            <>
              <RecordingDefaultsSection pushToast={pushToast} />
              <GpuEncodeSection pushToast={pushToast} />
            </>
          )}

          {active === 'tvdb' && <TvdbLinkSection pushToast={pushToast} />}

          {active === 'storage' && <StorageSection pushToast={pushToast} />}

          {active === 'maintenance' && <MaintenanceSection pushToast={pushToast} />}
        </div>
      </div>
    </div>
  );
};

// -----------------------------------------------------------------
// Tuner section — rich per-physical-tuner view. Feeds from:
// -----------------------------------------------------------------
// Device detail modal — opened from the device row. Shows metadata,
// exposes sync / delete actions, and lists channels belonging to this
// device with per-row enabled toggles. Channel ↔ device mapping uses
// the channels.source field (legacy 'm3u' for iptv-kind upserts).
// -----------------------------------------------------------------

interface DeviceDetailModalProps {
  device: ApiChannelSource;
  syncing: boolean;
  onClose: () => void;
  onSync: () => void;
  onDelete: () => Promise<void> | void;
  onToastError: (msg: string) => void;
}

const KIND_TO_CHANNEL_SOURCE: Record<string, string> = {
  mirakurun: 'mirakurun',
  iptv: 'm3u', // upsertM3uChannels writes source='m3u' even for iptv devices
};

const DeviceDetailModal = ({
  device,
  syncing,
  onClose,
  onSync,
  onDelete,
  onToastError,
}: DeviceDetailModalProps) => {
  const [channels, setChannels] = useState<ApiChannel[] | null>(null);
  const [loadingCh, setLoadingCh] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<ApiDeviceLiveStatus | null>(null);
  const [loadingLive, setLoadingLive] = useState(false);

  const channelSource = KIND_TO_CHANNEL_SOURCE[device.kind] ?? device.kind;

  const loadChannels = async () => {
    setLoadingCh(true);
    try {
      const rows = await api.channels.list({ source: channelSource });
      setChannels(rows);
    } catch (e) {
      onToastError(`チャンネル取得失敗: ${(e as Error).message}`);
    } finally {
      setLoadingCh(false);
    }
  };

  const loadLiveStatus = async () => {
    setLoadingLive(true);
    try {
      const all = await api.tuners.live();
      setLiveStatus(all.find((s) => s.sourceId === device.id) ?? null);
    } catch (e) {
      onToastError(`チューナー状態取得失敗: ${(e as Error).message}`);
    } finally {
      setLoadingLive(false);
    }
  };

  useEffect(() => {
    void loadChannels();
    void loadLiveStatus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleToggle = async (ch: ApiChannel) => {
    setToggling(ch.id);
    const next = !ch.enabled;
    // Optimistic update so the toggle feels instant; revert on failure.
    setChannels((prev) =>
      prev ? prev.map((c) => (c.id === ch.id ? { ...c, enabled: next } : c)) : prev
    );
    try {
      await api.channels.patch(ch.id, { enabled: next });
    } catch (e) {
      setChannels((prev) =>
        prev ? prev.map((c) => (c.id === ch.id ? { ...c, enabled: !next } : c)) : prev
      );
      onToastError(`切替失敗: ${(e as Error).message}`);
    } finally {
      setToggling(null);
    }
  };

  const enabledCount = channels?.filter((c) => c.enabled).length ?? 0;

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropClick}>
      <div className="modal device-modal" role="dialog" aria-modal="true" aria-label={device.name}>
        <div className="modal-head">
          <div className="device-modal-head">
            <div>
              <div className="modal-title">{device.name}</div>
              <div className="device-modal-meta">
                {[device.model, device.friendlyName, device.tunerCount ? `${device.tunerCount} チューナー` : null]
                  .filter((v): v is string => !!v)
                  .join(' · ') || device.kind}
              </div>
              <div className="device-modal-url" title={device.url}>{device.url}</div>
              {device.xmltvUrl && (
                <div className="device-modal-url subtle" title={device.xmltvUrl}>
                  XMLTV: {device.xmltvUrl}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-body device-modal-body">
          <div className="device-modal-actions">
            <div className="device-modal-stats">
              <span><span className="stat-num">{channels?.length ?? '—'}</span> チャンネル</span>
              <span className="stat-sep">·</span>
              <span><span className="stat-num">{enabledCount}</span> 有効</span>
              {device.lastSyncAt && (
                <>
                  <span className="stat-sep">·</span>
                  <span className="device-modal-sync-time">
                    最終同期 {new Date(device.lastSyncAt).toLocaleString('ja-JP')}
                  </span>
                </>
              )}
              {device.lastError && (
                <span className="device-modal-error" title={device.lastError}>エラー</span>
              )}
              {liveStatus && (
                <>
                  <span className="stat-sep">·</span>
                  <span
                    className={`device-modal-reach ${liveStatus.reachable ? 'ok' : 'ng'}`}
                    title={liveStatus.reachable ? '応答あり' : '応答なし'}
                  >
                    {liveStatus.reachable ? '接続OK' : '到達不可'}
                  </span>
                </>
              )}
            </div>
            <div className="device-modal-action-buttons">
              <button
                className="btn btn-sm ghost"
                onClick={onSync}
                disabled={syncing}
              >
                {syncing ? '同期中…' : '再sync'}
              </button>
              <button
                className="btn btn-sm ghost device-modal-delete"
                onClick={() => void onDelete()}
              >
                削除
              </button>
            </div>
          </div>

          <div className="device-tuner-status">
            <div className="device-tuner-status-head">
              <span className="device-tuner-status-title">チューナー状態</span>
              <button
                className="btn btn-sm ghost"
                onClick={() => void loadLiveStatus()}
                disabled={loadingLive}
              >
                {loadingLive ? '取得中…' : '更新'}
              </button>
            </div>
            {loadingLive && !liveStatus && <div className="src-empty">読み込み中…</div>}
            {!loadingLive && !liveStatus && (
              <div className="src-empty">チューナー状態を取得できませんでした。</div>
            )}
            {liveStatus && liveStatus.tuners.length === 0 && (
              <div className="src-empty">
                {liveStatus.reachable
                  ? 'この機器はチューナー状態の取得に対応していません。'
                  : '機器に到達できませんでした。'}
              </div>
            )}
            {liveStatus && liveStatus.tuners.length > 0 && (
              <div className="device-tuner-list">
                {liveStatus.tuners.map((t) => (
                  <div
                    key={t.tunerIdx}
                    className={`device-tuner-row${t.inUse ? ' in-use' : ''}`}
                  >
                    <span className="device-tuner-idx">#{t.tunerIdx}</span>
                    <span className={`device-tuner-state ${t.inUse ? 'on' : 'off'}`}>
                      {t.inUse ? '使用中' : 'アイドル'}
                    </span>
                    <span className="device-tuner-ch">
                      {t.inUse
                        ? [t.channelNumber, t.channelName].filter(Boolean).join(' ') || '—'
                        : '—'}
                    </span>
                    <span className="device-tuner-client" title={t.clientIp ?? ''}>
                      {t.clientIp ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="device-channel-list">
            {loadingCh && <div className="src-empty">読み込み中…</div>}
            {!loadingCh && channels && channels.length === 0 && (
              <div className="src-empty">
                まだチャンネルはありません。上の「再sync」を押して取得してください。
              </div>
            )}
            {!loadingCh && channels && channels.map((c) => (
              <div key={c.id} className={`device-channel-row${c.enabled ? '' : ' disabled'}`}>
                <span className={`channel-type-chip bc-${c.type.toLowerCase()}`}>{c.type}</span>
                <span className="device-channel-num">{c.number || '—'}</span>
                <span className="device-channel-name">{c.name}</span>
                <button
                  type="button"
                  className={`toggle${c.enabled ? ' on' : ''}`}
                  onClick={() => void handleToggle(c)}
                  disabled={toggling === c.id}
                  aria-pressed={c.enabled}
                  aria-label={c.enabled ? '無効化' : '有効化'}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <div className="spacer" />
          <button className="btn btn-sm" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
};

// -----------------------------------------------------------------
// Storage section — wires /system.storage (statfs on RECORDING_DIR) so
// the UI reflects the real filesystem. The recording-dir path itself
// and the auto-sweep threshold come from env vars (RECORDING_DIR /
// DISK_SWEEP_MIN_FREE_GB) and aren't exposed via the admin API, so we
// don't surface them here.
// -----------------------------------------------------------------

interface StorageSectionProps {
  pushToast?: (msg: string, kind?: 'ok' | 'err') => void;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // Use 2 decimals above MB, 1 below.
  const digits = i >= 3 ? 2 : i >= 2 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

const StorageSection = ({ pushToast }: StorageSectionProps) => {
  const [status, setStatus] = useState<ApiSystemStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const s = await api.system.status();
      setStatus(s);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      pushToast?.(`ストレージ取得失敗: ${(e as Error).message}`, 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const total = status?.storage.totalBytes ?? 0;
  const used = status?.storage.usedBytes ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? 'warn' : pct >= 70 ? 'caution' : 'ok';

  return (
    <SettingsSection
      title="ストレージ"
      desc="録画先ファイルシステムの容量。保存先パスと自動整理のしきい値は環境変数 (RECORDING_DIR / DISK_SWEEP_MIN_FREE_GB) で設定します。"
    >
      <div className="storage-meter-row">
        <div className="storage-meter-head">
          {status ? (
            <>
              <span className="storage-used">{formatBytes(used)}</span>
              <span className="storage-sep">/</span>
              <span className="storage-total">{formatBytes(total)}</span>
              <span className={`storage-pct tone-${tone}`}>{pct}%</span>
            </>
          ) : (
            <span style={{ color: 'var(--fg-subtle)' }}>
              {loading ? '読み込み中…' : '取得に失敗しました'}
            </span>
          )}
          <button
            className="btn btn-sm ghost"
            onClick={() => void load()}
            disabled={loading}
            style={{ marginLeft: 'auto' }}
          >
            {loading ? '更新中…' : '再取得'}
          </button>
        </div>
        {status && (
          <div className="storage-meter">
            <div
              className={`storage-meter-fill tone-${tone}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>

      {err && !status && (
        <div className="settings-empty-row">取得に失敗: {err}</div>
      )}

      {status && (
        <div className="storage-meta-row">
          <span>ビルド {status.version}</span>
          <span className="tuner-count-sep">·</span>
          <span>本日の残り予約 {status.upcomingReserves} 件</span>
          <span className="tuner-count-sep">·</span>
          <span>基準日 {status.today}</span>
        </div>
      )}
    </SettingsSection>
  );
};

// -----------------------------------------------------------------
// Recording defaults — DB-backed (admin_settings under the `rec.*`
// namespace) via adminSettingsService. Every new reservation that omits
// a field inherits from here. Selects save on change; margins save on
// blur so arrow-key tweaks don't thrash the backend.
// -----------------------------------------------------------------

interface RecordingDefaultsSectionProps {
  pushToast?: (msg: string, kind?: 'ok' | 'err') => void;
}

const QUALITY_LABEL: Record<ApiQuality, string> = {
  '1080i': '1080i (放送そのまま)',
  '720p':  '720p (軽量)',
};

const PRIORITY_LABEL: Record<ApiPriority, string> = {
  low:    '低 (録画優先)',
  medium: '中 (標準)',
  high:   '高 (即エンコード)',
};

const PRESET_LABEL: Record<ApiRecEncodePreset, string> = {
  'h265-1080p':       'H.265 1080p',
  'h264-720p':        'H.264 720p',
  'audio-only':       '音声のみ',
  'h265-1080p-nvenc': 'H.265 1080p (NVENC)',
  'h264-720p-nvenc':  'H.264 720p (NVENC)',
  'h265-1080p-vaapi': 'H.265 1080p (VAAPI)',
  'h264-720p-vaapi':  'H.264 720p (VAAPI)',
  'h265-1080p-qsv':   'H.265 1080p (QSV)',
  'h264-720p-qsv':    'H.264 720p (QSV)',
};

const RecordingDefaultsSection = ({ pushToast }: RecordingDefaultsSectionProps) => {
  const [defaults, setDefaults] = useState<ApiRecDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.admin.settings.get().then((s) => {
      if (!cancelled) {
        setDefaults(s.rec);
        setLoading(false);
      }
    }).catch((e) => {
      if (!cancelled) {
        setLoading(false);
        pushToast?.(`取得失敗: ${(e as Error).message}`, 'err');
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Partial<ApiRecDefaults>) => {
    if (!defaults) return;
    const prev = defaults;
    // Optimistic — revert on failure.
    setDefaults({ ...prev, ...patch });
    setSaving(true);
    try {
      const next = await api.admin.settings.patch({ rec: patch });
      setDefaults(next.rec);
    } catch (e) {
      setDefaults(prev);
      pushToast?.(`保存失敗: ${(e as Error).message}`, 'err');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !defaults) {
    return (
      <SettingsSection title="録画・エンコード (デフォルト)" desc="新規予約に適用する初期値。">
        <div className="settings-empty-row">{loading ? '読み込み中…' : '取得に失敗しました'}</div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="録画・エンコード (デフォルト)"
      desc="新規予約に適用する初期値。"
    >
      <div style={SETTING_ROW_STYLE}>
        <div style={SETTING_LABEL_STYLE}>デフォルト品質</div>
        <div style={{ fontSize: 12 }}>
          <select
            value={defaults.quality}
            onChange={(e) => void save({ quality: e.target.value as ApiQuality })}
            disabled={saving}
            className="control-sm"
          >
            {(Object.keys(QUALITY_LABEL) as ApiQuality[]).map((k) => (
              <option key={k} value={k}>{QUALITY_LABEL[k]}</option>
            ))}
          </select>
        </div>
        <span />
      </div>

      <div style={SETTING_ROW_STYLE}>
        <div style={SETTING_LABEL_STYLE}>エンコードプリセット</div>
        <div style={{ fontSize: 12 }}>
          <select
            value={defaults.encodePreset}
            onChange={(e) => void save({ encodePreset: e.target.value as ApiRecEncodePreset })}
            disabled={saving}
            className="control-sm"
          >
            {(Object.keys(PRESET_LABEL) as ApiRecEncodePreset[]).map((k) => (
              <option key={k} value={k}>{PRESET_LABEL[k]}</option>
            ))}
          </select>
        </div>
        <span />
      </div>

      <div style={SETTING_ROW_STYLE}>
        <div style={SETTING_LABEL_STYLE}>エンコード優先度</div>
        <div style={{ fontSize: 12 }}>
          <select
            value={defaults.priority}
            onChange={(e) => void save({ priority: e.target.value as ApiPriority })}
            disabled={saving}
            className="control-sm"
          >
            {(Object.keys(PRIORITY_LABEL) as ApiPriority[]).map((k) => (
              <option key={k} value={k}>{PRIORITY_LABEL[k]}</option>
            ))}
          </select>
        </div>
        <span />
      </div>

      <div style={SETTING_ROW_STYLE}>
        <div style={SETTING_LABEL_STYLE}>前/後マージン</div>
        <div style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <MarginInput
            value={defaults.marginPre}
            onCommit={(v) => void save({ marginPre: v })}
            disabled={saving}
            ariaLabel="前マージン (秒)"
          />
          <span style={{ color: 'var(--fg-muted)' }}>秒 /</span>
          <MarginInput
            value={defaults.marginPost}
            onCommit={(v) => void save({ marginPost: v })}
            disabled={saving}
            ariaLabel="後マージン (秒)"
          />
          <span style={{ color: 'var(--fg-muted)' }}>秒</span>
        </div>
        <span />
      </div>

      <div style={SETTING_ROW_LAST_STYLE}>
        <div style={SETTING_LABEL_STYLE}>TS (raw) 保持</div>
        <div style={{ fontSize: 12 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={defaults.keepRaw}
              onChange={(e) => void save({ keepRaw: e.target.checked })}
              disabled={saving}
            />
            <span style={{ fontSize: 11 }}>
              エンコード後も .ts を残す
            </span>
          </label>
        </div>
        <span />
      </div>
    </SettingsSection>
  );
};

// Committed-on-blur number input — raw keystrokes stay local so intermediate
// values like "5" (before typing "0") don't fire PATCH. Commits on blur or
// Enter, reverts on Escape.
interface MarginInputProps {
  value: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
}
const MarginInput = ({ value, onCommit, disabled, ariaLabel }: MarginInputProps) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const n = parseInt(draft, 10);
    const clamped = Number.isFinite(n) ? Math.max(0, Math.min(600, n)) : value;
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      className="control-sm"
      type="number"
      min={0}
      max={600}
      step={10}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        else if (e.key === 'Escape') { setDraft(String(value)); e.currentTarget.blur(); }
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{ width: 72, fontFamily: 'var(--font-mono)' }}
    />
  );
};

// Row / label styles shared by RecordingDefaultsSection + TvdbLinkSection.
const SETTING_ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '180px 1fr auto',
  gap: 14,
  alignItems: 'center',
  padding: '11px 14px',
  borderBottom: '1px solid var(--border)',
};
const SETTING_ROW_LAST_STYLE: CSSProperties = { ...SETTING_ROW_STYLE, borderBottom: 'none' };
const SETTING_LABEL_STYLE: CSSProperties = { fontSize: 12, color: 'var(--fg-muted)' };

// -----------------------------------------------------------------
// TVDB API key entry. The server only exposes the last 4 chars of the
// stored key, so the display shows '•••3f4a' (never the raw key). The
// "設定" button toggles an inline input; saving PATCHes the whole key,
// saving an empty string clears it.
// -----------------------------------------------------------------

interface TvdbLinkSectionProps {
  pushToast?: (msg: string, kind?: 'ok' | 'err') => void;
}

function maskedKey(last4: string | null): string {
  if (!last4) return '';
  return '•'.repeat(Math.max(8, 12 - last4.length)) + last4;
}

const TvdbLinkSection = ({ pushToast }: TvdbLinkSectionProps) => {
  const [snapshot, setSnapshot] = useState<ApiAdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.admin.settings.get().then((s) => {
      if (!cancelled) { setSnapshot(s); setLoading(false); }
    }).catch((e) => {
      if (!cancelled) { setLoading(false); pushToast?.(`取得失敗: ${(e as Error).message}`, 'err'); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (body: ApiAdminSettingsPatch) => {
    setSaving(true);
    try {
      const next = await api.admin.settings.patch(body);
      setSnapshot(next);
      setEditing(false);
      setDraft('');
    } catch (e) {
      pushToast?.(`保存失敗: ${(e as Error).message}`, 'err');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !snapshot) {
    return (
      <SettingsSection title="シリーズ連携 (TVDB)" desc="シリーズを TVDB と照合してシーズン・話数を整理します。">
        <div className="settings-empty-row">{loading ? '読み込み中…' : '取得に失敗しました'}</div>
      </SettingsSection>
    );
  }

  const { apiKey } = snapshot.tvdb;

  return (
    <SettingsSection
      title="シリーズ連携 (TVDB)"
      desc="シリーズを TVDB と照合してシーズン・話数を整理します。"
    >
      <div style={SETTING_ROW_LAST_STYLE}>
        <div style={SETTING_LABEL_STYLE}>TVDB APIキー</div>
        <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          {editing ? (
            <input
              className="control-sm"
              type="text"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save({ tvdb: { apiKey: draft.trim() } });
                else if (e.key === 'Escape') { setEditing(false); setDraft(''); }
              }}
              placeholder="TVDB v4 APIキーを入力"
              style={{ width: '100%', maxWidth: 320, fontFamily: 'var(--font-mono)' }}
              disabled={saving}
            />
          ) : apiKey.source === 'db' ? (
            maskedKey(apiKey.last4)
          ) : (
            <span style={{ color: 'var(--fg-subtle)', fontFamily: 'inherit' }}>(未設定)</span>
          )}
        </div>
        {editing ? (
          <div style={{ display: 'inline-flex', gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={() => void save({ tvdb: { apiKey: draft.trim() } })}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              className="btn btn-sm ghost"
              onClick={() => { setEditing(false); setDraft(''); }}
              disabled={saving}
            >
              取消
            </button>
            {apiKey.source === 'db' && (
              <button
                className="btn btn-sm ghost"
                onClick={() => void save({ tvdb: { apiKey: '' } })}
                disabled={saving}
                title="保存済みキーを削除"
              >
                削除
              </button>
            )}
          </div>
        ) : (
          <button className="btn btn-sm ghost" onClick={() => { setDraft(''); setEditing(true); }}>
            {apiKey.source === 'db' ? '変更' : '設定'}
          </button>
        )}
      </div>
    </SettingsSection>
  );
};

// ============ 発見 (Discover) ============
// JCOM の「予約ランキング」を直接叩いた結果をサーバー側で定期キャッシュし、
// /rankings から取得して表示する。ポスターはサーバーが TVDB とマッチさせた
// ものがあればそれを、無ければシード文字列ベースのプレースホルダを使う。
interface DiscoverCategory {
  key: ApiRankingGenre;
  label: string;
  sub: string;
}

const CATEGORIES: DiscoverCategory[] = [
  { key: 'all',   label: '総合',             sub: 'JCOM総合' },
  { key: 'drama', label: 'ドラマ',           sub: '話題の連ドラ' },
  { key: 'anime', label: 'アニメ',           sub: '今期の新作' },
  { key: 'movie', label: '映画',             sub: '劇場・放送' },
  { key: 'doc',   label: 'ドキュメンタリー', sub: '深掘り番組' },
  { key: 'var',   label: 'バラエティ',       sub: '話題回' },
  { key: 'sport', label: 'スポーツ',         sub: '中継・特集' },
  { key: 'music', label: '音楽',             sub: 'ライブ・特番' },
  { key: 'edu',   label: '教育',             sub: '学び' },
];

export interface DiscoverPageProps {
  /** Existing series-linked rules (by TVDB id) — used to flag "already added". */
  existingSeriesIds: Set<number>;
  /** Invoked after successfully creating a series rule so the parent can refresh. */
  onAdded?: (tvdb: ApiTvdbEntry) => void;
  /** Invoked when the user unsubscribes an already-added series rule. */
  onRemove?: (tvdbId: number) => Promise<void>;
}

type DeltaTone = 'up' | 'down' | '';

function deltaTone(d: number | null): DeltaTone {
  if (d == null || d === 0) return '';
  return d > 0 ? 'up' : 'down';
}

function deltaLabel(d: number | null): string {
  if (d == null) return 'NEW';
  if (d === 0) return '—';
  return d > 0 ? `▲${d}` : `▼${Math.abs(d)}`;
}

function syncedLabel(iso: string | undefined): string {
  if (!iso) return '';
  const age = Date.now() - Date.parse(iso);
  if (!Number.isFinite(age) || age < 0) return '';
  const min = Math.round(age / 60_000);
  if (min < 1) return 'たった今';
  if (min < 60) return `更新 ${min}分前`;
  const h = Math.round(min / 60);
  return `更新 ${h}時間前`;
}

const VALID_GENRE_KEYS = new Set<string>(CATEGORIES.map((c) => c.key));

export const DiscoverPage = ({ existingSeriesIds, onAdded, onRemove }: DiscoverPageProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  // The selected category is URL-state (`?genre=drama`, `?genre=anime`, …)
  // so the Discover page is shareable and bookmarkable per genre. Missing
  // or unknown values fall back to the "総合" default.
  const rawGenre = searchParams.get('genre');
  const cat: ApiRankingGenre =
    rawGenre && VALID_GENRE_KEYS.has(rawGenre) ? (rawGenre as ApiRankingGenre) : 'all';
  const setCat = (next: ApiRankingGenre) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'all') p.delete('genre');
        else p.set('genre', next);
        return p;
      },
      { replace: false },
    );
  };
  const [items, setItems] = useState<ApiRankingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  // Guide への path 遷移はせず、Discover 上で `?modal=X` を push するだけ。
  // close 側は App 側の closeModal が state 印を見て navigate(-1) → /discover
  // に対称に戻る。
  const openNextProgramModal = (nextProgramId: string) => {
    pushModalToUrl(setSearchParams, nextProgramId);
  };

  const handleRemove = async (tvdbId: number, title: string) => {
    if (!onRemove) return;
    if (!window.confirm(`「${title}」の自動録画ルールを解除しますか？`)) return;
    setRemoving(tvdbId);
    try {
      await onRemove(tvdbId);
    } catch (e) {
      console.warn('[discover] remove failed', (e as Error).message);
    } finally {
      setRemoving(null);
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    // Clear stale category data immediately so the previous category's top
    // items don't flash during the category-switch fetch (課題#16).
    setItems([]);
    setLoading(true);
    setError(null);
    api.rankings
      .list(cat, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setItems(res.items);
        setSyncedAt(res.items[0]?.syncedAt);
      })
      .catch((e: Error) => {
        // Ignore fetches aborted by our own cleanup (StrictMode double-mount
        // in dev, or rapid category toggling). Anything else is a real error.
        if (ctrl.signal.aborted || e.name === 'AbortError') return;
        setError(e.message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [cat]);

  const handleAdd = async (item: ApiRankingItem) => {
    const tv = item.tvdb;
    if (!tv || tv.type !== 'series') return;
    setAdding(tv.id);
    try {
      await api.rules.create({
        name: tv.title,
        keyword: tv.title,
        // No channel restriction — JCOM ranking rows don't always map to a
        // known channel in our lineup, and series rules across channels are
        // fine for a one-click "follow" UX.
        channels: [],
        enabled: true,
        priority: 'medium',
        quality: '1080i',
        skipReruns: true,
        kind: 'series',
        tvdb: tv,
      });
      onAdded?.(tv);
    } catch (e) {
      console.warn('[discover] add failed', (e as Error).message);
    } finally {
      setAdding(null);
    }
  };

  const top3 = cat === 'all' ? items.slice(0, 3) : [];
  const rest = cat === 'all' ? items.slice(3) : items;

  return (
    <div className="page">
      <PageHead title="発見">
        <div
          style={{
            fontSize: 11,
            color: 'var(--fg-subtle)',
            fontFamily: 'var(--font-mono)',
            padding: '6px 0',
          }}
        >
          {syncedLabel(syncedAt) || '—'} · JCOM
        </div>
      </PageHead>

      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={`discover-cat ${cat === c.key ? 'active' : ''}`}
            onClick={() => setCat(c.key)}
          >
            <div className="dc-label">{c.label}</div>
            <div className="dc-sub">{c.sub}</div>
          </button>
        ))}
      </div>

      {error && (
        <div
          style={{
            padding: '10px 12px',
            marginBottom: 14,
            background: 'var(--bg-muted)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--fg-muted)',
          }}
        >
          ランキングの取得に失敗しました: {error}
        </div>
      )}

      {loading && items.length === 0 && (
        <div
          style={{
            padding: '24px 0',
            textAlign: 'center',
            fontSize: 12,
            color: 'var(--fg-subtle)',
          }}
        >
          読み込み中…
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div
          style={{
            padding: '24px 0',
            textAlign: 'center',
            fontSize: 12,
            color: 'var(--fg-subtle)',
          }}
        >
          このカテゴリのランキングはまだ取得されていません。3時間ごとに自動で同期されます。
        </div>
      )}

      {cat === 'all' && top3.length > 0 && (
        <div className="discover-top3">
          {top3.map((item) => {
            const tv = item.tvdb;
            const seed = tv?.slug ?? item.title;
            const sub = tv ? `${tv.titleEn} · ${tv.network}` : item.channelName ?? '';
            const added = tv ? existingSeriesIds.has(tv.id) : false;
            const canAdd = !!tv && tv.type === 'series';
            const tone = deltaTone(item.delta);
            return (
              <div key={`${cat}-${item.rank}`} className="discover-feature">
                <div className="discover-feature-rank">#{item.rank}</div>
                <Poster seed={seed} label={tv?.titleEn ?? item.title} size="xl" poster={tv?.poster ?? null} />
                <div className="discover-feature-meta">
                  <div className="discover-feature-title">
                    {tv?.title ?? item.title}
                  </div>
                  <div className="discover-feature-sub">{sub}</div>
                  {item.quote && (
                    item.nextProgramId ? (
                      <button
                        type="button"
                        className="discover-feature-quote discover-quote-link"
                        onClick={() => openNextProgramModal(item.nextProgramId!)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          font: 'inherit',
                          color: 'inherit',
                          textAlign: 'left',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          textDecorationStyle: 'dotted',
                          textUnderlineOffset: 2,
                        }}
                        title="次回放送の番組表を開く"
                      >
                        「{item.quote}」
                      </button>
                    ) : (
                      <div className="discover-feature-quote">「{item.quote}」</div>
                    )
                  )}
                  <div className="discover-feature-stats">
                    <span>
                      <Icon name="sparkle" size={10} /> #{item.rank}
                    </span>
                    {item.channelName && <span>{item.channelName}</span>}
                    <span className={`delta ${tone}`}>{deltaLabel(item.delta)}</span>
                  </div>
                  <div style={{ marginTop: 'auto', paddingTop: 10 }}>
                    {!canAdd ? (
                      <button className="btn btn-sm" disabled style={{ opacity: 0.6 }}>
                        {tv ? '映画 · ルール対象外' : 'TVDB未紐付け'}
                      </button>
                    ) : added ? (
                      <button
                        className="btn btn-sm discover-remove"
                        onClick={() => tv && void handleRemove(tv.id, tv.title)}
                        disabled={!onRemove || removing === tv?.id}
                        title="解除する"
                      >
                        <Icon name="check" size={10} /> 追加済み{' '}
                        <span className="discover-remove-x" aria-hidden="true">×</span>
                        <span className="sr-only"> 解除</span>
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm accent"
                        onClick={() => void handleAdd(item)}
                        disabled={adding === tv?.id}
                      >
                        <Icon name="plus" size={10} /> シリーズを追加
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {items.length > 0 && (
        <div
          className="section-label"
          style={{ marginTop: cat === 'all' ? 24 : 0 } as CSSProperties}
        >
          {cat === 'all' ? 'ランキング続き' : 'ランキング'}{' '}
          <span style={{ color: 'var(--fg-subtle)', marginLeft: 6 }}>
            {items.length}件
          </span>
        </div>
      )}

      <div className="discover-list">
        {rest.map((item) => {
          const tv = item.tvdb;
          const seed = tv?.slug ?? item.title;
          const tone = deltaTone(item.delta);
          const added = tv ? existingSeriesIds.has(tv.id) : false;
          const canAdd = !!tv && tv.type === 'series';
          return (
            <div key={`${cat}-${item.rank}`} className="discover-row">
              <div className="discover-rank">
                <div className="discover-rank-num">{item.rank}</div>
                <div className={`delta ${tone}`} style={{ fontSize: 10 }}>
                  {deltaLabel(item.delta)}
                </div>
              </div>
              <Poster seed={seed} label={tv?.titleEn ?? item.title} size="sm" poster={tv?.poster ?? null} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="discover-title">{tv?.title ?? item.title}</div>
                <div className="discover-quote">
                  {item.quote ? (
                    item.nextProgramId ? (
                      <button
                        type="button"
                        onClick={() => openNextProgramModal(item.nextProgramId!)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          font: 'inherit',
                          color: 'inherit',
                          textAlign: 'left',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          textDecorationStyle: 'dotted',
                          textUnderlineOffset: 2,
                        }}
                        title="次回放送の番組表を開く"
                      >
                        「{item.quote}」
                      </button>
                    ) : (
                      <>「{item.quote}」</>
                    )
                  ) : ''}
                  {item.channelName ? ` — ${item.channelName}` : ''}
                </div>
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  color: 'var(--fg-subtle)',
                  fontFamily: 'var(--font-mono)',
                  minWidth: 60,
                  textAlign: 'right',
                }}
              >
                {tv ? tv.titleEn : '—'}
              </div>
              {!canAdd ? (
                <button className="btn btn-sm" disabled style={{ opacity: 0.6 }}>
                  {tv ? '—' : '未紐付'}
                </button>
              ) : added ? (
                <button
                  className="btn btn-sm discover-remove"
                  onClick={() => tv && void handleRemove(tv.id, tv.title)}
                  disabled={!onRemove || removing === tv?.id}
                  title="解除する"
                >
                  追加済{' '}
                  <span className="discover-remove-x" aria-hidden="true">×</span>
                  <span className="sr-only"> 解除</span>
                </button>
              ) : (
                <button
                  className="btn btn-sm accent"
                  onClick={() => void handleAdd(item)}
                  disabled={adding === tv?.id}
                >
                  <Icon name="plus" size={10} /> 追加
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
