// Right-side detail/reserve panel for the program guide. Replaces
// ReserveModal on the `/` route — when a program is selected (?modal=<id>),
// the guide route mounts this in place of the overlay so the user can
// browse rich TVDB info (jacket, cast, related episodes) and act on it
// (reserve / cancel / stop) without losing the grid context.
import { useEffect, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { Icon } from './Icon';
import { durLabel, getChannel, progId, findSeries, MOCK_NOW_MIN, toMin } from '../lib/epg';
import { jpAirDate } from '../lib/adapters';
import { hasPoster, posterStyle } from '../lib/tvdbVisual';
import { api } from '../api/epghub';
import type { ApiTvdbCastMember } from '../api/epghub';
import type {
  Channel,
  Program,
  TvdbEntry,
  TvdbSeries,
} from '../data/types';

export interface GuidePanelProps {
  program: Program | null;
  channels: Channel[];
  programs: Program[];
  reservedIds: Set<string>;
  existingSeriesIds?: Set<number>;
  recordingIdForProgram?: (programId: string) => string | null;
  onClose: () => void;
  onReserve: (p: Program) => void;
  onCreateRule: (keyword: string, p: Program, channels?: string[]) => void;
  onCreateSeriesLink: (tvdb: TvdbSeries, p: Program, channels?: string[]) => void;
  onUnsubscribeSeries?: (tvdbId: number) => void;
  onStopRecording?: (recordingId: string) => void;
  onSelectProgram: (p: Program) => void;
}

type Priority = 'high' | 'medium' | 'low';
type Quality = '1080i' | '720p';

const STAFF_KEYS = ['監督', '脚本', '原作', '製作', '演出', '音楽', '声優', 'スタッフ'];

export function GuidePanel(props: GuidePanelProps) {
  const { program } = props;
  if (!program) return null;
  // key on progId so internal state (mode, settings popover) resets when
  // the user switches between programs via the related-episodes list.
  return <GuidePanelInner key={progId(program)} {...props} program={program} />;
}

interface InnerProps extends GuidePanelProps {
  program: Program;
}

function GuidePanelInner({
  program,
  channels,
  programs,
  reservedIds,
  existingSeriesIds,
  recordingIdForProgram,
  onClose,
  onReserve,
  onCreateRule,
  onCreateSeriesLink,
  onUnsubscribeSeries,
  onStopRecording,
  onSelectProgram,
}: InnerProps) {
  const ch = getChannel(channels, program.ch);
  const tvdb: TvdbEntry | null = program.tvdb ?? null;
  const isMovieTvdb = tvdb?.type === 'movie';
  const isSeriesTvdb = tvdb?.type === 'series';
  const isMovieGenre = program.genre.key === 'movie';
  const isMovie = isMovieTvdb || isMovieGenre;
  const seriesEps = isSeriesTvdb ? findSeries(programs, program.series) : [];
  const related = isSeriesTvdb
    ? seriesEps.filter((p) => progId(p) !== progId(program)).slice(0, 8)
    : [];

  const ext = program.extended ?? null;
  const staff = pickExtendedKv(ext, STAFF_KEYS);
  // Cast comes from TVDB only — the ARIB broadcaster strings are noisy
  // (mixed roles, free-form names) and don't carry headshots, so we don't
  // fall back to them.
  const tvdbCast = useTvdbCast(tvdb?.id ?? null);

  const reserved = reservedIds.has(progId(program));
  const seriesId = tvdb?.id ?? null;
  const coveredBySeriesRule =
    seriesId != null && !!existingSeriesIds && existingSeriesIds.has(seriesId);
  const isLive = toMin(program.start) <= MOCK_NOW_MIN && toMin(program.end) > MOCK_NOW_MIN;
  const apiRecordingId = program.id && recordingIdForProgram
    ? recordingIdForProgram(program.id)
    : null;

  const subtitle =
    isSeriesTvdb && program.tvdbSeason != null && program.tvdbEpisode != null
      ? `S${program.tvdbSeason} · 第${program.tvdbEpisode}話${program.tvdbEpisodeName ? `「${program.tvdbEpisodeName}」` : ''}`
      : program.tvdbEpisodeName ?? program.ep ?? null;

  return (
    <div className="guide-modal-backdrop" onClick={onClose} data-testid="guide-panel">
      <div
        className="guide-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
      >
        <button
          type="button"
          className="gp-close"
          onClick={onClose}
          aria-label="閉じる"
          title="閉じる"
        >
          <Icon name="x" size={14} />
        </button>

        <div
          className={`gp-hero${tvdb && hasPoster(tvdb) ? ' has-poster' : ''}`}
          style={
            tvdb && hasPoster(tvdb)
              ? ({ '--gp-hero-bg': `url("${tvdb.poster}")` } as CSSProperties)
              : undefined
          }
        >
          <div className="gp-hero-inner">
            {tvdb && hasPoster(tvdb) ? (
              <div className="gp-hero-poster" style={posterStyle(tvdb)} />
            ) : (
              <div
                className="gp-hero-poster gp-hero-poster-fallback"
                style={neutralHeroBg(program)}
              >
                {isMovie ? 'MOVIE' : 'TV'}
              </div>
            )}
            <div className="gp-hero-meta">
              <div className="gp-kind-row">
                {tvdb && (
                  <span className="gp-kind-pill">{isMovie ? '映画' : 'シリーズ'}</span>
                )}
                {tvdb?.year && tvdb.year > 0 && <span>{tvdb.year}</span>}
                {tvdb?.network && (
                  <>
                    {tvdb.year > 0 && <span className="gp-meta-sep">·</span>}
                    <span>{tvdb.network}</span>
                  </>
                )}
                {!tvdb && <span>{program.genre.label}</span>}
              </div>
              <h2 className="gp-title">{tvdb?.title ?? program.title}</h2>
              {tvdb?.titleEn && tvdb.titleEn !== tvdb.title && (
                <div className="gp-title-en">{tvdb.titleEn}</div>
              )}
              {subtitle && <div className="gp-subtitle">{subtitle}</div>}
              <div className="gp-channel-row">
                {ch && (
                  <span className="gp-channel">
                    <span className="gp-channel-dot" style={{ background: ch.color }} />
                    {ch.name}
                  </span>
                )}
                <span className="gp-meta-sep">·</span>
                <span className="gp-time">{program.start}–{program.end}</span>
                <span className="gp-meta-sep">·</span>
                <span>{durLabel(program)}</span>
                {program.hd && (
                  <>
                    <span className="gp-meta-sep">·</span>
                    <span className="gp-hd">HD</span>
                  </>
                )}
              </div>
              <div className="gp-tag-row">
                <span
                  className="gp-tag"
                  style={{ '--tag-dot': program.genre.dot } as CSSProperties}
                >
                  <span className="gp-tag-dot" />
                  {program.genre.label}
                </span>
                {tvdb && (
                  <span className="gp-tag tvdb">
                    <Icon name="sparkle" size={10} /> TVDB #{tvdb.id}
                  </span>
                )}
                {program.recording && (
                  <span className="gp-tag rec">
                    <span className="gp-tag-rec-dot" /> REC
                  </span>
                )}
                {reserved && !program.recording && (
                  <span className="gp-tag reserved">
                    <Icon name="check" size={10} /> 予約済
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="gp-body">

        {reserved || coveredBySeriesRule ? (
          <ReservedBlock
            program={program}
            tvdb={tvdb}
            isLive={isLive}
            coveredBySeriesRule={coveredBySeriesRule}
            apiRecordingId={apiRecordingId}
            onCancel={() => onReserve(program)}
            onStopRecording={onStopRecording}
            onUnsubscribeSeries={onUnsubscribeSeries}
          />
        ) : (
          <ReserveBlock
            program={program}
            channel={ch ?? null}
            tvdb={tvdb}
            isMovie={isMovie}
            isSeriesTvdb={isSeriesTvdb}
            isMovieGenre={isMovieGenre}
            isMovieTvdb={isMovieTvdb}
            seriesEps={seriesEps}
            existingSeriesIds={existingSeriesIds}
            onReserve={onReserve}
            onCreateRule={onCreateRule}
            onCreateSeriesLink={onCreateSeriesLink}
          />
        )}

        {program.desc && (
          <Section title="あらすじ">
            <p className="gp-desc">{program.desc}</p>
          </Section>
        )}

        {tvdbCast.length > 0 && (
          <Section title="出演者">
            <div className="gp-cast-grid">
              {tvdbCast.slice(0, 8).map((c, i) => (
                <div
                  key={`${c.name}-${i}`}
                  className="gp-cast-item"
                  title={c.role ? `${c.name} — ${c.role}` : c.name}
                >
                  <div
                    className={`gp-cast-avatar${c.image ? ' has-photo' : ''}`}
                    style={c.image ? { backgroundImage: `url("${c.image}")` } : undefined}
                  >
                    {!c.image && (c.name.slice(0, 1) || '?')}
                  </div>
                  <div className="gp-cast-name">{c.name || c.role || '—'}</div>
                  {c.role && <div className="gp-cast-role">{c.role}</div>}
                </div>
              ))}
            </div>
          </Section>
        )}

        {staff.length > 0 && (
          <Section title="スタッフ">
            <dl className="gp-staff-list">
              {staff.slice(0, 6).map(([k, v]) => (
                <div key={k} className="gp-staff-row">
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        {related.length > 0 && (
          <Section title="関連番組">
            <ul className="gp-related-list">
              {related.map((rel) => {
                const rch = getChannel(channels, rel.ch);
                return (
                  <li key={progId(rel)}>
                    <button
                      type="button"
                      className="gp-related-item"
                      onClick={() => onSelectProgram(rel)}
                    >
                      <div className="gp-related-when">
                        {rel.startAt ? jpAirDate(rel.startAt).slice(5, 16) : rel.start}
                      </div>
                      <div className="gp-related-main">
                        <div className="gp-related-title">{rel.title}</div>
                        <div className="gp-related-meta">
                          <span>{rch?.name ?? rel.ch}</span>
                          <span className="gp-meta-sep">·</span>
                          <span>{rel.start}–{rel.end}</span>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}
        </div>
      </div>
    </div>
  );
}

interface ReserveBlockProps {
  program: Program;
  channel: Channel | null;
  tvdb: TvdbEntry | null;
  isMovie: boolean;
  isSeriesTvdb: boolean;
  isMovieGenre: boolean;
  isMovieTvdb: boolean;
  seriesEps: Program[];
  existingSeriesIds?: Set<number>;
  onReserve: (p: Program) => void;
  onCreateRule: (keyword: string, p: Program, channels?: string[]) => void;
  onCreateSeriesLink: (tvdb: TvdbSeries, p: Program, channels?: string[]) => void;
}

function ReserveBlock({
  program,
  channel,
  tvdb,
  isMovie,
  isSeriesTvdb,
  isMovieGenre,
  isMovieTvdb,
  seriesEps,
  existingSeriesIds,
  onReserve,
  onCreateRule,
  onCreateSeriesLink,
}: ReserveBlockProps) {
  const [priority, setPriority] = useState<Priority>('medium');
  const [quality, setQuality] = useState<Quality>('1080i');
  const [keepRaw, setKeepRaw] = useState(false);
  const [restrictToChannel, setRestrictToChannel] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const seriesAlreadyRuled =
    isSeriesTvdb && tvdb && !!existingSeriesIds && existingSeriesIds.has(tvdb.id);
  const settingsDirty =
    priority !== 'medium' || quality !== '1080i' || keepRaw || !restrictToChannel;
  const sizeHintGb = Math.round(
    program.sizeRaw || (toMin(program.end) - toMin(program.start)) * 0.13,
  );
  // Drop unused ref to priority/quality/keepRaw so the server fills them in
  // from admin defaults — settings popover still collects them for future
  // wiring, but the direct-action buttons omit them today.
  void priority; void quality; void keepRaw;

  return (
    <div className="gp-reserve">
      <div className="gp-mode-grid">
        <ActionCard
          onClick={() => onReserve(program)}
          title="この回のみ録画"
          desc="1回だけ録画"
        />
        {!isMovie && isSeriesTvdb && !seriesAlreadyRuled && tvdb && tvdb.type === 'series' && (
          <ActionCard
            onClick={() => onCreateSeriesLink(tvdb, program, [program.ch])}
            title="シリーズを追加"
            desc={`全${seriesEps.length}回を自動で予約`}
            recommended
          />
        )}
        {!isMovie && !tvdb && (
          <ActionCard
            onClick={() =>
              onCreateRule(
                program.title.slice(0, 14),
                program,
                restrictToChannel ? [program.ch] : [],
              )
            }
            title="自動予約ルール"
            desc="同じ番組を今後も自動録画"
          />
        )}
      </div>

      {isSeriesTvdb && seriesAlreadyRuled && (
        <div className="gp-outcome accent">
          <Icon name="check" size={12} />
          <div>
            シリーズ「{tvdb!.title}」は自動予約済み。
            この回は <strong>「この回のみ」</strong> で上書き予約できます。
          </div>
        </div>
      )}
      {isMovieTvdb && (
        <div className="gp-outcome accent">
          <Icon name="check" size={12} />
          <div>
            映画はライブラリの <strong>映画タブ</strong> に追加されます。再放送時の重複予約はスキップ。
          </div>
        </div>
      )}
      {isMovieGenre && !isMovieTvdb && (
        <div className="gp-outcome">
          <Icon name="sparkle" size={12} />
          <div>TVDB 紐付けがないため、再放送時の自動予約はありません。</div>
        </div>
      )}

      <div className="gp-settings-anchor">
        <button
          type="button"
          className={`gp-settings-link${settingsDirty ? ' has-dot' : ''}${settingsOpen ? ' active' : ''}`}
          onClick={() => setSettingsOpen((o) => !o)}
          aria-expanded={settingsOpen}
        >
          <span>録画設定</span>
          <Icon name="chevD" size={10} className={`gp-settings-chev${settingsOpen ? ' open' : ''}`} />
        </button>
        {settingsOpen && (
          <div className="gp-settings-accordion" role="region" aria-label="録画設定">
            <SettingsRow label="優先度">
              <div className="seg-sm">
                {(['high', 'medium', 'low'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={priority === p ? 'active' : ''}
                    onClick={() => setPriority(p)}
                  >
                    {p === 'high' ? '高' : p === 'medium' ? '中' : '低'}
                  </button>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow label="品質">
              <div className="seg-sm">
                {(['1080i', '720p'] as const).map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={quality === q ? 'active' : ''}
                    onClick={() => setQuality(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow label="TSを残す">
              <div className="seg-sm">
                <button
                  type="button"
                  className={!keepRaw ? 'active' : ''}
                  onClick={() => setKeepRaw(false)}
                >
                  削除
                </button>
                <button
                  type="button"
                  className={keepRaw ? 'active' : ''}
                  onClick={() => setKeepRaw(true)}
                >
                  保存
                </button>
              </div>
              <span className={`gp-settings-hint ${keepRaw ? '' : 'dim'}`}>
                +{sizeHintGb} GB
              </span>
            </SettingsRow>
            {!tvdb && (
              <SettingsRow label="対象局">
                <div className="seg-sm">
                  <button
                    type="button"
                    className={restrictToChannel ? 'active' : ''}
                    onClick={() => setRestrictToChannel(true)}
                  >
                    {channel?.name ?? program.ch}のみ
                  </button>
                  <button
                    type="button"
                    className={!restrictToChannel ? 'active' : ''}
                    onClick={() => setRestrictToChannel(false)}
                  >
                    全局
                  </button>
                </div>
              </SettingsRow>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ReservedBlockProps {
  program: Program;
  tvdb: TvdbEntry | null;
  isLive: boolean;
  coveredBySeriesRule: boolean;
  apiRecordingId: string | null;
  onCancel: () => void;
  onStopRecording?: (recordingId: string) => void;
  onUnsubscribeSeries?: (tvdbId: number) => void;
}

function ReservedBlock({
  program,
  tvdb,
  isLive,
  coveredBySeriesRule,
  apiRecordingId,
  onCancel,
  onStopRecording,
  onUnsubscribeSeries,
}: ReservedBlockProps) {
  const sourceText = coveredBySeriesRule && tvdb
    ? `シリーズ自動予約「${tvdb.title}」`
    : tvdb
      ? (tvdb.type === 'movie' ? `映画「${tvdb.title}」` : `シリーズ「${tvdb.title}」`)
      : (program.ruleMatched ? `ルール「${program.ruleMatched}」` : '単発予約');
  return (
    <div className="gp-reserved">
      <div className={`gp-reserved-strip ${isLive ? 'live' : ''}`}>
        {isLive ? (
          <>
            <span className="gp-rec-badge"><span className="gp-rec-badge-dot" /> REC</span>
            <span>録画中 · 残り{toMin(program.end) - MOCK_NOW_MIN}分</span>
          </>
        ) : (
          <>
            <span className="gp-status-badge">
              <Icon name="check" size={10} /> 予約済
            </span>
            <span>放送開始まで待機</span>
          </>
        )}
      </div>
      <dl className="gp-reserved-meta">
        <div className="gp-reserved-row">
          <dt>予約元</dt>
          <dd>{sourceText}</dd>
        </div>
        <div className="gp-reserved-row">
          <dt>品質</dt>
          <dd className="mono">1080i</dd>
        </div>
      </dl>
      <div className="gp-cta-row">
        <div className="gp-cta-spacer" />
        {coveredBySeriesRule && tvdb ? (
          <button
            type="button"
            className="btn danger"
            disabled={!onUnsubscribeSeries}
            onClick={() => {
              if (onUnsubscribeSeries) onUnsubscribeSeries(tvdb.id);
            }}
          >
            シリーズ予約を解除
          </button>
        ) : (
          <button
            type="button"
            className="btn danger"
            onClick={
              isLive && apiRecordingId && onStopRecording
                ? () => onStopRecording(apiRecordingId)
                : onCancel
            }
          >
            {isLive ? '録画を停止' : '予約を取り消す'}
          </button>
        )}
      </div>
    </div>
  );
}

interface ActionCardProps {
  onClick: () => void;
  title: string;
  desc: string;
  recommended?: boolean;
}

function ActionCard({ onClick, title, desc, recommended }: ActionCardProps) {
  return (
    <button type="button" onClick={onClick} className="gp-mode-card">
      <span className="gp-mode-body">
        <span className="gp-mode-title">
          {title}
          {recommended && <span className="gp-mode-recommend">推奨</span>}
        </span>
        <span className="gp-mode-desc">{desc}</span>
      </span>
      <Icon name="chevR" size={12} className="gp-mode-chev" />
    </button>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <section className="gp-section">
      <div className="gp-section-title">{title}</div>
      {children}
    </section>
  );
}

interface SettingsRowProps {
  label: string;
  children: React.ReactNode;
}

function SettingsRow({ label, children }: SettingsRowProps) {
  return (
    <div className="gp-settings-row">
      <span className="gp-settings-row-label">{label}</span>
      {children}
    </div>
  );
}

// ARIB 拡張ディスクリプタから既知キーを順に拾って key/value タプル化。
// 出演者は使わない（TVDB cast に統一）。スタッフ系のみ。
function pickExtendedKv(
  ext: Record<string, string> | null,
  keys: string[],
): Array<[string, string]> {
  if (!ext) return [];
  return keys.flatMap((k) => (ext[k] ? [[k, ext[k]] as [string, string]] : []));
}

// Lazy cast lookup — returns `[]` until the server responds. Errors
// silently: the UI falls back to ARIB broadcaster names when the TVDB
// lookup is unavailable (fixture mode, no-key, etc.).
function useTvdbCast(tvdbId: number | null): ApiTvdbCastMember[] {
  const [cast, setCast] = useState<ApiTvdbCastMember[]>([]);
  useEffect(() => {
    if (tvdbId == null) {
      setCast([]);
      return;
    }
    let cancelled = false;
    api.tvdb
      .getCast(tvdbId)
      .then((rows) => {
        if (!cancelled) setCast(rows);
      })
      .catch(() => {
        if (!cancelled) setCast([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tvdbId]);
  return cast;
}

function neutralHeroBg(p: Program): CSSProperties {
  // Stable procedural gradient when there's no TVDB poster — keeps the
  // panel from looking empty. Keyed on channel + title so re-renders feel
  // consistent.
  const hash = (p.ch + p.title).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    background: `linear-gradient(145deg, oklch(0.55 0.10 ${hash % 360}), oklch(0.30 0.08 ${(hash * 3) % 360}))`,
  };
}
