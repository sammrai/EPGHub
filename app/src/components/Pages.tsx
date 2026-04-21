// Pages: Library (merged), Reserves (status), Discover, Settings
// Rules lives in Agenda.tsx

import { useEffect, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
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
  ApiRankingItem,
  ApiRankingGenre,
  ApiRecording,
  ApiUpdateRecording,
  ApiTvdbEntry,
  ApiChannelSource,
  ApiChannelSourceKind,
  ApiGpuEncoder,
  ApiGpuProbeResult,
  ApiGpuStatus,
} from '../api/epghub';

// ============ SHARED ============
export interface PageHeadProps {
  title: string;
  desc?: string;
  children?: ReactNode;
}

export const PageHead = ({ title, desc, children }: PageHeadProps) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {desc && <p>{desc}</p>}
    </div>
    {children && <div style={{ display: 'flex', gap: 8 }}>{children}</div>}
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
      <PageHead
        title="ライブラリ"
        desc="録画されたすべてのタイトル。シリーズはTVDBでまとめ、映画は1本ごと、それ以外は録画物として並びます。"
      >
        <button className="btn" onClick={onGoGuide}>
          番組表から追加
        </button>
      </PageHead>

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
                <MovieLibCard key={'m' + it.m.r.id} m={it.m} channels={channels} onDeleted={onDeleted} />
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
                <MovieLibRow key={'m' + it.m.r.id} m={it.m} channels={channels} onDeleted={onDeleted} />
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
}

const MovieLibCard = ({ m, channels, onDeleted }: MovieLibCardProps) => {
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
    <div className="series-lib-card">
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
}

const MovieLibRow = ({ m, channels, onDeleted }: MovieLibRowProps) => {
  const ch = channels.find((c) => c.id === m.r.ch);
  const handleDelete = makeDeleteHandler({ id: m.r.id, title: m.tvdb.title }, onDeleted);
  const subParts = [
    m.tvdb.titleEn,
    m.tvdb.year > 0 ? String(m.tvdb.year) : null,
    m.tvdb.director || null,
  ].filter(Boolean);
  return (
    <div className="res-row">
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

interface SeriesDetailProps {
  series: SeriesListEntry;
  onBack: () => void;
  toggleRule: (id: number) => void;
}

const SeriesDetail = ({ series: s, onBack: _onBack, toggleRule }: SeriesDetailProps) => {
  void _onBack;
  const counts = seriesCounts(s.tvdb, s.recorded);
  const [season, setSeason] = useState<number>(counts.currentSeason || 1);
  const recordedInSeason = s.recorded
    .filter((e) => e.season === season)
    .sort((a, b) => (b.ep ?? 0) - (a.ep ?? 0));
  const seasonsSet = new Set<number>(
    s.recorded.map((e) => e.season).filter((n): n is number => n != null)
  );
  if (counts.currentSeason > 0) seasonsSet.add(counts.currentSeason);
  const seasons = Array.from(seasonsSet).sort((a, b) => b - a);
  // Pad seasons only if TVDB gave us an authoritative season count.
  for (let i = 1; i <= s.tvdb.totalSeasons; i++)
    if (!seasons.includes(i)) seasons.push(i);
  seasons.sort((a, b) => b - a);
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
      <PageHead
        title="予約・状態"
        desc="録画中・エンコード中・今後の予約を1つのテーブルで。"
      />

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
                type="number"
                value={marginPre}
                min={0}
                onChange={(e) => setMarginPre(Math.max(0, Number(e.target.value) || 0))}
                style={{
                  width: 80,
                  padding: '6px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                }}
              />
            </label>
            <label className="opt-label">
              <span className="opt-label-text">後マージン (秒)</span>
              <input
                type="number"
                value={marginPost}
                min={0}
                onChange={(e) => setMarginPost(Math.max(0, Number(e.target.value) || 0))}
                style={{
                  width: 80,
                  padding: '6px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                }}
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
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ApiChannelSourceKind>('m3u');
  const [url, setUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);

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

  const handleCreate = async (e: ReactMouseEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim()) {
      pushToast?.('名前と URL を入力してください', 'err');
      return;
    }
    setCreating(true);
    try {
      await api.admin.channelSources.create({ name: name.trim(), kind, url: url.trim() });
      setName('');
      setUrl('');
      await load();
      pushToast?.(`チャンネルソースを追加しました`);
    } catch (e) {
      pushToast?.(`追加失敗: ${(e as Error).message}`, 'err');
    } finally {
      setCreating(false);
    }
  };

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

  const handleRemove = async (id: number, nameLabel: string) => {
    if (!window.confirm(`「${nameLabel}」を削除しますか？`)) return;
    try {
      await api.admin.channelSources.remove(id);
      await load();
      pushToast?.(`削除しました`);
    } catch (e) {
      pushToast?.(`削除失敗: ${(e as Error).message}`, 'err');
    }
  };

  return (
    <SettingsSection
      title="チャンネルソース"
      desc="Mirakurun や m3u IPTV プレイリストを登録してチャンネル一覧を生成します。録画は channels.streamUrl を直接使います。"
    >
      <form
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 110px 1.6fr auto',
          gap: 8,
          padding: '11px 14px',
          borderBottom: '1px solid var(--border)',
          alignItems: 'center',
        }}
      >
        <input
          className="input"
          placeholder="名前 (例: IPTV JP)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ fontSize: 12 }}
        />
        <select
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as ApiChannelSourceKind)}
          style={{ fontSize: 12 }}
        >
          <option value="m3u">m3u</option>
          <option value="mirakurun">mirakurun</option>
        </select>
        <input
          className="input"
          placeholder="URL (https://... .m3u や http://mirakurun:40772)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}
        />
        <button className="btn btn-sm" onClick={handleCreate} disabled={creating}>
          {creating ? '追加中…' : '追加'}
        </button>
      </form>

      {loading && (
        <div style={{ padding: '14px', fontSize: 12, color: 'var(--fg-subtle)' }}>
          読み込み中…
        </div>
      )}
      {!loading && sources.length === 0 && (
        <div style={{ padding: '14px', fontSize: 12, color: 'var(--fg-subtle)' }}>
          まだ登録されているソースはありません。
        </div>
      )}
      {sources.map((s) => (
        <div
          key={s.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 70px 2fr 140px 70px auto auto',
            gap: 10,
            alignItems: 'center',
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
            background: s.lastError ? 'color-mix(in oklch, var(--bg) 92%, red 8%)' : undefined,
          }}
          title={s.lastError ?? undefined}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {s.name}
            {s.lastError && (
              <span style={{ color: '#c33', marginLeft: 6, fontSize: 11 }}>●</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
            {s.kind}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-mono)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={s.url}
          >
            {s.url}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
            {s.lastSyncAt
              ? new Date(s.lastSyncAt).toLocaleString('ja-JP')
              : '未同期'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'right' }}>
            {s.channelCount} ch
          </div>
          <button
            className="btn btn-sm ghost"
            onClick={() => void handleSync(s.id)}
            disabled={syncingId === s.id}
          >
            {syncingId === s.id ? '同期中…' : '再sync'}
          </button>
          <button
            className="btn btn-sm ghost"
            onClick={() => void handleRemove(s.id, s.name)}
          >
            削除
          </button>
        </div>
      ))}
    </SettingsSection>
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
            className="input"
            value={status?.preferred ?? ''}
            disabled={!hasAny || saving}
            onChange={(e) => {
              const v = e.target.value;
              void saveSettings({ preferred: v === '' ? null : (v as ApiGpuEncoder) });
            }}
            style={{ fontSize: 12 }}
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

export const SettingsPage = ({ pushToast }: SettingsPageProps = {}) => (
  <div className="page settings-page">
    <PageHead title="設定" desc="録画・保存・シリーズ連携・通知の設定。" />
    <MaintenanceSection pushToast={pushToast} />
    <ChannelSourcesSection pushToast={pushToast} />
    <GpuEncodeSection pushToast={pushToast} />
    <SettingsSection
      title="シリーズ連携 (TVDB)"
      desc="シリーズをTVDBと自動で照合し、シーズン・話数を整理します。"
    >
      <SettingRow label="TVDB APIキー" value="••••••••••3f4a" action="再発行" />
      <SettingRow
        label="自動マッチング"
        value="有効 (信頼度80%以上)"
        action="変更"
      />
      <SettingRow
        label="未マッチ時の動作"
        value="キーワードルールとして保存"
        action="変更"
      />
    </SettingsSection>
    <SettingsSection
      title="録画・エンコード"
      desc="デフォルトの録画設定とエンコードプリセット。"
    >
      <SettingRow label="デフォルト品質" value="1080i" action="変更" />
      <SettingRow
        label="エンコードプリセット"
        value="H.265 1080p / Opus"
        action="変更"
      />
      <SettingRow label="エンコード優先度" value="低 (録画優先)" action="変更" />
      <SettingRow label="前/後マージン" value="0秒 / 30秒" action="変更" />
    </SettingsSection>
    <SettingsSection
      title="ストレージ"
      desc="録画ファイルの保存先と自動整理ポリシー。"
    >
      <SettingRow
        label="録画先"
        value="/mnt/nas/recordings"
        action="変更"
        mono
      />
      <SettingRow
        label="使用容量"
        value="5.42 / 8.0 TB (67%)"
        action="詳細"
      />
      <SettingRow label="自動削除" value="視聴済み90日後" action="変更" />
    </SettingsSection>
    <SettingsSection
      title="チューナー"
      desc="Mirakurunが検出した受信デバイス。OSに見える順に一覧されます。"
    >
      <TunerSetup />
    </SettingsSection>
  </div>
);

// Tuner setup — Plex-inspired "scanning for hardware" flow + per-device list
interface TunerEntry {
  ch: string;
  type: string;
  state: 'recording' | 'idle';
  program: string | null;
  signal: number;
}

interface TunerDevice {
  id: string;
  name: string;
  bus: string;
  firmware: string;
  tuners: TunerEntry[];
}

const TUNER_DEVICES: TunerDevice[] = [
  {
    id: 'px-w3u4-1',
    name: 'PLEX PX-W3U4',
    bus: 'USB',
    firmware: '2.1.0',
    tuners: [
      { ch: 'T0', type: 'GR', state: 'recording', program: '大相撲春巡業 中継', signal: 28.4 },
      { ch: 'T1', type: 'GR', state: 'idle', program: null, signal: 27.9 },
      { ch: 'S0', type: 'BS', state: 'idle', program: null, signal: 17.2 },
      { ch: 'S1', type: 'BS', state: 'idle', program: null, signal: 17.0 },
    ],
  },
  {
    id: 'pt3-1',
    name: 'Earthsoft PT3',
    bus: 'PCIe',
    firmware: '1.0.0',
    tuners: [
      { ch: 'T0', type: 'GR', state: 'idle', program: null, signal: 29.1 },
      { ch: 'T1', type: 'GR', state: 'idle', program: null, signal: 28.7 },
      { ch: 'S0', type: 'BS/CS', state: 'idle', program: null, signal: 18.1 },
      { ch: 'S1', type: 'BS/CS', state: 'idle', program: null, signal: 17.8 },
    ],
  },
];

const TunerSetup = () => {
  const [scanning, setScanning] = useState(false);
  const totalTuners = TUNER_DEVICES.reduce((s, d) => s + d.tuners.length, 0);
  const inUse = TUNER_DEVICES.reduce(
    (s, d) => s + d.tuners.filter((t) => t.state !== 'idle').length,
    0
  );

  return (
    <div className="tuner-setup">
      <div className="tuner-summary">
        <div>
          <div className="tuner-summary-main">
            <span className="tuner-count">
              <span className="tuner-count-num">{TUNER_DEVICES.length}</span>{' '}
              台のデバイス
            </span>
            <span className="tuner-count-sep">·</span>
            <span>
              <span className="tuner-count-num">{totalTuners}</span> チューナー
            </span>
            <span className="tuner-count-sep">·</span>
            <span className="tuner-count-inuse">{inUse} 使用中</span>
          </div>
          <div className="tuner-summary-sub">
            Mirakurun経由で検出されたチューナー。同時録画可能数は合計チューナー数が上限です。
          </div>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => {
            setScanning(true);
            setTimeout(() => setScanning(false), 2400);
          }}
        >
          {scanning ? '検索中…' : 'デバイスを再検索'}
        </button>
      </div>

      {scanning && (
        <div className="tuner-scan">
          <span className="tuner-scan-dot" />
          新しいハードウェアを検索しています… 見つからない場合も引き続きスキャンします。
        </div>
      )}

      {TUNER_DEVICES.map((d) => (
        <div key={d.id} className="tuner-device">
          <div className="tuner-device-head">
            <div>
              <div className="tuner-device-name">{d.name}</div>
              <div className="tuner-device-meta">
                {d.bus} · ファームウェア {d.firmware} · ID {d.id}
              </div>
            </div>
            <span className="tuner-device-status on">
              <span className="dot" />
              接続中
            </span>
          </div>
          <div className="tuner-list">
            {d.tuners.map((t) => (
              <div key={t.ch} className={`tuner-item ${t.state}`}>
                <span className="tuner-ch">{t.ch}</span>
                <span className="tuner-type">{t.type}</span>
                <span className="tuner-state">
                  {t.state === 'recording' && (
                    <>
                      <span className="rec-dot" />
                      録画中
                    </>
                  )}
                  {t.state === 'idle' && (
                    <span style={{ color: 'var(--fg-subtle)' }}>待機</span>
                  )}
                </span>
                <span className="tuner-program">{t.program || '—'}</span>
                <span className="tuner-signal">{t.signal.toFixed(1)} dB</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="tuner-empty-hint">
        接続してもデバイスが表示されない場合は、
        <a href="#" onClick={(e) => e.preventDefault()}>
          Mirakurunのログ
        </a>
        を確認してください。対応ハードウェア: PX-W3U4 / PX-Q3U4 / PT3 / PLEX
        DTV02A-1T1S-U。
      </div>
    </div>
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

export const DiscoverPage = ({ existingSeriesIds, onAdded, onRemove }: DiscoverPageProps) => {
  const [, setSearchParams] = useSearchParams();
  const [cat, setCat] = useState<ApiRankingGenre>('all');
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
      <PageHead
        title="発見"
        desc="JCOM TV ガイドの予約ランキング。気になる番組があれば、TVDBで見つかったシリーズはそのまま自動録画対象に追加できます。"
      >
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
