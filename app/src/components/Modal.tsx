// Reservation modal — two states:
//   (1) "Not yet reserved" — choose one / series / rule, set options
//   (2) "Already reserved" — show reservation summary + manage (edit, cancel)
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { toMin, durLabel, MOCK_NOW_MIN, findSeries, progId, getChannel } from '../lib/epg';
import { jpAirDate } from '../lib/adapters';
import { api, ApiError } from '../api/epghub';
import type { ApiTvdbEntry, ApiTvdbEpisode } from '../api/epghub';
import type {
  Channel,
  Program,
  TvdbEntry,
  TvdbMovie,
  TvdbSeries,
} from '../data/types';

export interface ReserveModalProps {
  program: Program | null;
  onClose: () => void;
  onReserve: (p: Program) => void;
  onCreateRule: (keyword: string, p: Program, channels?: string[]) => void;
  onCreateSeriesLink: (tvdb: TvdbSeries, p: Program, channels?: string[]) => void;
  reservedIds: Set<string>;
  channels: Channel[];
  programs: Program[];
  tvdb: Record<string, TvdbEntry>;
  /** Active recording lookup (by programId). When the current program is
   *  actively recording, the modal uses this to resolve the recordingId
   *  so it can call onStopRecording(recordingId). */
  recordingIdForProgram?: (programId: string) => string | null;
  /** TVDB series ids that already have a series rule registered.
   *  When the current program's tvdb.id is in this set, the modal
   *  shows "シリーズ予約済" and hides the "シリーズを追加" option. */
  existingSeriesIds?: Set<number>;
  /** Delete the series rule for the given TVDB id. Wired so the modal
   *  can offer "シリーズ予約を解除" without sending the user to the
   *  Rules tab. */
  onUnsubscribeSeries?: (tvdbId: number) => void;
  /** Stop an active recording early. Called instead of onCancel (which
   *  DELETEs the recording) when the program is currently being recorded. */
  onStopRecording?: (recordingId: string) => void;
  /** Invoked after a manual match/unmatch so the parent can refetch. */
  onTvdbChange?: () => void;
}

export function ReserveModal({
  program,
  onClose,
  onReserve,
  onCreateRule,
  onCreateSeriesLink,
  reservedIds,
  channels,
  programs,
  tvdb,
  recordingIdForProgram,
  existingSeriesIds,
  onUnsubscribeSeries,
  onStopRecording,
  onTvdbChange,
}: ReserveModalProps) {
  if (!program) return null;
  const alreadyReserved = reservedIds.has(progId(program));
  // "Reserved via a series rule" = the program's TVDB series is already
  // registered as a series rule, so rule.expand will handle the actual
  // reserve. We surface the same "ReservedModal" UI to avoid offering
  // "シリーズを追加" again on the same id.
  const entryId = program.tvdb?.id ?? null;
  const coveredBySeriesRule =
    entryId != null && !!existingSeriesIds && existingSeriesIds.has(entryId);

  if (alreadyReserved || coveredBySeriesRule) {
    // The live-recording branch needs an API recordingId so it can POST
    // /recordings/:id/stop. fixture-only programs may not have one; in that
    // case we fall back to the DELETE path (onReserve) which will try to
    // remove by program match — same behaviour as before.
    const apiRecordingId = program.id && recordingIdForProgram
      ? recordingIdForProgram(program.id)
      : null;
    return (
      <ReservedModal
        program={program}
        onClose={onClose}
        onCancel={() => onReserve(program)}
        onStopRecording={
          apiRecordingId && onStopRecording
            ? () => onStopRecording(apiRecordingId)
            : undefined
        }
        channels={channels}
        programs={programs}
        tvdb={tvdb}
        coveredBySeriesRule={coveredBySeriesRule}
        onUnsubscribeSeries={onUnsubscribeSeries}
        onTvdbChange={onTvdbChange}
      />
    );
  }
  return (
    <ReserveNewModal
      program={program}
      onClose={onClose}
      onReserve={onReserve}
      onCreateRule={onCreateRule}
      onCreateSeriesLink={onCreateSeriesLink}
      channels={channels}
      programs={programs}
      tvdb={tvdb}
      existingSeriesIds={existingSeriesIds}
      onTvdbChange={onTvdbChange}
    />
  );
}

// ---------- Already-reserved state ----------
interface ReservedModalProps {
  program: Program;
  onClose: () => void;
  onCancel: () => void;
  /** When set (and the reserve is currently recording), the danger button
   *  becomes "録画を停止" and invokes this instead of onCancel — which
   *  DELETEs the reserve and would leave the already-written .part
   *  unfinalized. See POST /reserves/:id/stop for the backend flow. */
  onStopRecording?: () => void;
  channels: Channel[];
  programs: Program[];
  tvdb: Record<string, TvdbEntry>;
  /** True when this program is covered by an existing TVDB series rule
   *  rather than a direct reserve. Shows "シリーズ予約を解除" instead
   *  of the single-reserve cancel button. */
  coveredBySeriesRule?: boolean;
  onUnsubscribeSeries?: (tvdbId: number) => void;
  onTvdbChange?: () => void;
}

function ReservedModal({ program, onClose, onCancel, onStopRecording, channels, programs, tvdb, coveredBySeriesRule, onUnsubscribeSeries, onTvdbChange }: ReservedModalProps) {
  const ch = getChannel(channels, program.ch);
  // Prefer the server-resolved match on the program itself; fall back to the
  // legacy series-keyed catalog lookup so fixture data keeps working.
  const entry: TvdbEntry | null =
    program.tvdb ?? (program.series ? (tvdb[program.series] ?? null) : null);
  const [editingTvdb, setEditingTvdb] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const isLive = toMin(program.start) <= MOCK_NOW_MIN && toMin(program.end) > MOCK_NOW_MIN;
  const minsUntil = toMin(program.start) - MOCK_NOW_MIN;
  const isMovieTvdb = entry?.type === 'movie';
  const isSeriesTvdb = entry != null && entry.type === 'series';
  const isMovieGenre = program.genre?.key === 'movie';
  const seriesEps: Program[] = isSeriesTvdb ? findSeries(programs, program.series) : [];

  // Reservation settings summary. When the program is covered via a series
  // rule (rather than a manual single reserve), reflect that.
  const sourceText = coveredBySeriesRule && entry
    ? `シリーズ自動予約「${entry.title}」`
    : entry
      ? (entry.type === 'movie' ? `映画「${entry.title}」` : `シリーズ「${entry.title}」`)
      : (program.ruleMatched ? `ルール「${program.ruleMatched}」` : '単発予約');
  const settings = {
    priority: program.priority || 'medium',
    quality: '1080i',
    keepRaw: false,
    margin: { pre: 0, post: 30 },
    source: sourceText,
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal reserved-modal ${(isMovieTvdb || isSeriesTvdb) ? 'has-hero' : ''} ${isMovieTvdb ? 'has-movie-hero' : ''} ${isSeriesTvdb ? 'has-series-hero' : ''}`}
        onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
      >
        {/* Status strip — always on top */}
        <div className={`reserved-strip ${isLive ? 'live' : ''}`}>
          {isLive ? (
            <>
              <span className="rec-badge"><span className="rec-badge-dot" /> REC</span>
              <span>録画中 · 残り{toMin(program.end) - MOCK_NOW_MIN}分</span>
            </>
          ) : (
            <>
              <span className="status-badge up"><Icon name="check" size={10} /> 予約済</span>
              <span>{minsUntil < 60 ? `あと${minsUntil}分で開始` : minsUntil < 60 * 24 ? `あと${Math.floor(minsUntil / 60)}時間${minsUntil % 60}分` : '本日中に録画'}</span>
            </>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {program.start}–{program.end}
          </span>
        </div>

        {isMovieTvdb && entry && entry.type === 'movie' && ch && (
          <MovieHero program={program} tvdb={entry} ch={ch} onEditTvdb={() => setEditingTvdb(true)} />
        )}
        {isSeriesTvdb && entry && entry.type === 'series' && ch && (
          <SeriesHero program={program} tvdb={entry} ch={ch} seriesEps={seriesEps} onEditTvdb={() => setEditingTvdb(true)} />
        )}
        {!isMovieTvdb && !isSeriesTvdb && (
          <div className="modal-head">
            <div className="modal-channel-line">
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{ch?.name}</span>
              <span>{durLabel(program)}</span>
              <span>{program.genre.label}</span>
              {program.hd && <span>HD</span>}
            </div>
            <div className="modal-title-row">
              <div className="modal-title">{program.title}</div>
              <TvdbEditIcon onClick={() => setEditingTvdb(true)} linked={!!entry} />
            </div>
            {isMovieGenre && (
              <div className="modal-subtitle-row">
                <span className="kind-tag movie"><Icon name="sparkle" size={10} /> 映画</span>
                <span style={{ color: 'var(--fg-muted)' }}>TVDB未紐付け</span>
              </div>
            )}
            {program.ruleMatched && (
              <div className="modal-subtitle-row">
                <span className="kind-tag"><Icon name="sparkle" size={10} /> ルール予約</span>
                <span style={{ color: 'var(--fg-muted)' }}>「{program.ruleMatched}」に一致</span>
              </div>
            )}
          </div>
        )}

        <div className="modal-body">
          <div className="reserved-meta">
            <div className="rm-row">
              <span className="rm-label">予約元</span>
              <span className="rm-value">{settings.source}</span>
            </div>
            <div className="rm-row">
              <span className="rm-label">優先度</span>
              <span className="rm-value">
                {settings.priority === 'high' ? '高' : settings.priority === 'medium' ? '中' : '低'}
              </span>
            </div>
            <div className="rm-row">
              <span className="rm-label">品質</span>
              <span className="rm-value" style={{ fontFamily: 'var(--font-mono)' }}>{settings.quality}</span>
            </div>
            <div className="rm-row">
              <span className="rm-label">マージン</span>
              <span className="rm-value" style={{ fontFamily: 'var(--font-mono)' }}>
                前{settings.margin.pre}秒 / 後{settings.margin.post}秒
              </span>
            </div>
            <div className="rm-row">
              <span className="rm-label">TSファイル</span>
              <span className="rm-value">
                {settings.keepRaw
                  ? <span style={{ color: 'var(--fg)' }}>保持する</span>
                  : <span style={{ color: 'var(--fg-muted)' }}>エンコード後に削除</span>}
              </span>
            </div>
            <div className="rm-row">
              <span className="rm-label">エンコード</span>
              <span className="rm-value">H.265 1080p / Opus</span>
            </div>
          </div>

          <EpgDetails program={program} />

          <DebugDetailsTrigger onClick={() => setShowDebug(true)} />
        </div>

        <div className="modal-foot">
          <div className="spacer" />
          <button className="btn" onClick={onClose}>閉じる</button>
          {!coveredBySeriesRule && (
            <button className="btn ghost">
              <Icon name="settings" size={12} /> 設定を変更
            </button>
          )}
          {coveredBySeriesRule ? (
            <button
              className="btn danger"
              disabled={!entry || !onUnsubscribeSeries}
              onClick={() => {
                if (entry && onUnsubscribeSeries) onUnsubscribeSeries(entry.id);
              }}
            >
              シリーズ予約を解除
            </button>
          ) : (
            <button
              className="btn danger"
              onClick={isLive && onStopRecording ? onStopRecording : onCancel}
            >
              {isLive ? '録画を停止' : '予約を取り消す'}
            </button>
          )}
        </div>
      </div>
      {editingTvdb && (
        <TvdbEditModal
          program={program}
          entry={entry}
          onClose={() => setEditingTvdb(false)}
          onChange={onTvdbChange}
        />
      )}
      {showDebug && (
        <DebugDetailsModal program={program} onClose={() => setShowDebug(false)} />
      )}
    </div>
  );
}

// ---------- Not-yet-reserved state ----------
interface ReserveNewModalProps {
  program: Program;
  onClose: () => void;
  onReserve: (p: Program) => void;
  onCreateRule: (keyword: string, p: Program, channels?: string[]) => void;
  onCreateSeriesLink: (tvdb: TvdbSeries, p: Program, channels?: string[]) => void;
  channels: Channel[];
  programs: Program[];
  tvdb: Record<string, TvdbEntry>;
  existingSeriesIds?: Set<number>;
  onTvdbChange?: () => void;
}

type ReserveMode = 'once' | 'series' | 'rule';
type Priority = 'high' | 'medium' | 'low';
// Server accepts '1080i' (HD interlaced, native broadcast) or '720p'.
// Keep in sync with server/src/schemas/recording.ts QualitySchema.
type Quality = '1080i' | '720p';

function ReserveNewModal({
  program,
  onClose,
  onReserve,
  onCreateRule,
  onCreateSeriesLink,
  channels,
  programs,
  tvdb,
  existingSeriesIds,
  onTvdbChange,
}: ReserveNewModalProps) {
  const [mode, setMode] = useState<ReserveMode>('once');
  const [priority, setPriority] = useState<Priority>('medium');
  const [quality, setQuality] = useState<Quality>('1080i');
  const [keepRaw, setKeepRaw] = useState(false);
  const [editingTvdb, setEditingTvdb] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  // U5: Restrict the series/keyword rule to the current channel only (default),
  // or to all channels when unchecked.
  const [restrictToChannel, setRestrictToChannel] = useState(true);
  // Settings popover (priority / quality / keepRaw) — anchored to the gear
  // button in the footer. Replaces the old inline <details> row.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsAnchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    function onDown(e: globalThis.MouseEvent) {
      if (
        settingsAnchorRef.current &&
        !settingsAnchorRef.current.contains(e.target as Node)
      ) {
        setSettingsOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSettingsOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);
  const settingsDirty =
    priority !== 'medium' || quality !== '1080i' || keepRaw;
  const sizeHintGb = Math.round(
    program.sizeRaw || (toMin(program.end) - toMin(program.start)) * 0.13,
  );

  const ch = getChannel(channels, program.ch);
  const entry: TvdbEntry | null =
    program.tvdb ?? (program.series ? (tvdb[program.series] ?? null) : null);
  const isMovieTvdb = entry?.type === 'movie';
  const isMovieGenre = program.genre?.key === 'movie';
  const isMovie = isMovieTvdb || isMovieGenre;
  const isSeriesTvdb = entry != null && entry.type === 'series';
  const seriesAlreadyRuled =
    isSeriesTvdb && !!existingSeriesIds && existingSeriesIds.has(entry!.id);
  const seriesEps = findSeries(programs, program.series);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal ${(isMovieTvdb || isSeriesTvdb) ? 'has-hero' : ''} ${isMovieTvdb ? 'has-movie-hero' : ''} ${isSeriesTvdb ? 'has-series-hero' : ''}`}
        onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
      >
        {isMovieTvdb && entry && entry.type === 'movie' && ch && (
          <MovieHero program={program} tvdb={entry} ch={ch} onEditTvdb={() => setEditingTvdb(true)} />
        )}
        {isSeriesTvdb && entry && entry.type === 'series' && ch && (
          <SeriesHero program={program} tvdb={entry} ch={ch} seriesEps={seriesEps} onEditTvdb={() => setEditingTvdb(true)} />
        )}
        {!isMovieTvdb && !isSeriesTvdb && (
          <div className="modal-head">
            <div className="modal-channel-line">
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{ch?.name}</span>
              <span className="modal-time">{program.start}–{program.end}</span>
              <span>{durLabel(program)}</span>
              <span>{program.genre.label}</span>
            </div>
            <div className="modal-title-row">
              <div className="modal-title">{program.title}</div>
              <TvdbEditIcon onClick={() => setEditingTvdb(true)} linked={!!entry} />
            </div>
            {isMovieGenre && !isMovieTvdb && (
              <div className="modal-subtitle-row">
                <span className="kind-tag movie"><Icon name="sparkle" size={10} /> 映画</span>
                <span style={{ color: 'var(--fg-muted)' }}>TVDB未紐付け</span>
              </div>
            )}
          </div>
        )}

        <div className="modal-body">
          {!isMovie && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <ModeCard
                active={mode === 'once'}
                onClick={() => setMode('once')}
                title="この回のみ"
                desc="1回だけ録画"
                icon="check"
              />
              {isSeriesTvdb && !seriesAlreadyRuled && (
                <ModeCard
                  active={mode === 'series'}
                  onClick={() => setMode('series')}
                  title="シリーズを追加"
                  desc={`全${seriesEps.length}回を自動で予約`}
                  icon="sparkle"
                  recommended
                />
              )}
              {isSeriesTvdb && seriesAlreadyRuled && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    padding: '10px 12px',
                    background: 'var(--accent-soft)',
                    border: '1px solid var(--accent)',
                    borderRadius: 'var(--radius)',
                    fontSize: 12,
                    color: 'var(--fg)',
                  }}
                >
                  <Icon name="check" size={12} /> シリーズ「{entry!.title}」は自動予約済み。
                  この回は <strong>「この回のみ」</strong> で上書き予約できます。
                </div>
              )}
              {!entry && (
                <ModeCard
                  active={mode === 'rule'}
                  onClick={() => setMode('rule')}
                  title="自動予約ルール"
                  desc="同じ番組を今後も自動で録画"
                  icon="sparkle"
                />
              )}
            </div>
          )}

          {mode === 'rule' && !entry && (
            <div className="outcome">
              <div className="outcome-icon"><Icon name="sparkle" size={13} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="outcome-title">キーワードルールとして登録されます</div>
                <div className="outcome-desc">
                  「<strong>{program.title.slice(0, 14)}</strong>」を含む番組が今後自動で予約されます。<strong>ライブラリ</strong>ではルール録画としてまとまります。
                </div>
              </div>
            </div>
          )}
          {mode === 'once' && isMovieTvdb && (
            <div className="outcome outcome-accent">
              <div className="outcome-icon"><Icon name="check" size={13} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="outcome-title">この映画を録画してライブラリへ追加</div>
                <div className="outcome-desc">
                  <strong>ライブラリの映画タブ</strong>に整理されます。同じ映画が再放送されても、すでに録画済のため自動では再予約されません。
                </div>
              </div>
            </div>
          )}
          {mode === 'once' && isMovieGenre && !isMovieTvdb && (
            <div className="outcome">
              <div className="outcome-icon"><Icon name="sparkle" size={13} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="outcome-title">映画として1回だけ録画</div>
                <div className="outcome-desc">
                  TVDBに紐付いていない映画です。録画後にライブラリの映画タブに整理され、放送が再度あっても自動予約されません。
                </div>
              </div>
            </div>
          )}
          {(mode === 'series' || mode === 'rule') && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 8,
                fontSize: 12,
                color: 'var(--fg-muted)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={restrictToChannel}
                onChange={(e) => setRestrictToChannel(e.target.checked)}
              />
              <span>
                この局（<strong style={{ color: 'var(--fg)' }}>{ch?.name ?? program.ch}</strong>）でのみ録画
              </span>
              {!restrictToChannel && (
                <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                  全局が対象
                </span>
              )}
            </label>
          )}
          <EpgDetails program={program} />

          <DebugDetailsTrigger onClick={() => setShowDebug(true)} />
        </div>

        <div className="modal-foot">
          <div className="reserve-settings-anchor" ref={settingsAnchorRef}>
            <button
              type="button"
              className={`reserve-settings-link${settingsDirty ? ' has-dot' : ''}${settingsOpen ? ' active' : ''}`}
              onClick={() => setSettingsOpen((o) => !o)}
              aria-expanded={settingsOpen}
            >
              録画設定
            </button>
            {settingsOpen && (
              <div
                className="reserve-settings-popover"
                role="dialog"
                aria-label="録画設定"
              >
                <div className="rsp-title">録画設定</div>
                <label className="opt-label rsp-row">
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
                <label className="opt-label rsp-row">
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
                <label className="opt-label rsp-row">
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
                  <span className={`opt-hint ${keepRaw ? '' : 'dim'}`}>
                    +{sizeHintGb} GB
                  </span>
                </label>
              </div>
            )}
          </div>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>キャンセル</button>
          {mode === 'once' ? (
            <button className="btn primary" onClick={() => onReserve(program)}>予約する</button>
          ) : mode === 'series' && entry && entry.type === 'series' ? (
            <button
              className="btn accent"
              onClick={() =>
                onCreateSeriesLink(entry, program, restrictToChannel ? [program.ch] : [])
              }
            >
              <Icon name="sparkle" size={12} /> シリーズ登録
            </button>
          ) : (
            <button
              className="btn accent"
              onClick={() =>
                onCreateRule(
                  program.title.slice(0, 14),
                  program,
                  restrictToChannel ? [program.ch] : [],
                )
              }
            >
              <Icon name="sparkle" size={12} /> ルール作成
            </button>
          )}
        </div>
      </div>
      {editingTvdb && (
        <TvdbEditModal
          program={program}
          entry={entry}
          onClose={() => setEditingTvdb(false)}
          onChange={onTvdbChange}
        />
      )}
      {showDebug && (
        <DebugDetailsModal program={program} onClose={() => setShowDebug(false)} />
      )}
    </div>
  );
}

// Poster helpers — prefer the real TVDB jacket, fall back to a procedural
// oklch gradient keyed on tvdb.id so cards stay visually distinct even when
// an image is missing. fixtures + /search hits often ship empty `poster`.
function hasPoster(tvdb: TvdbEntry): boolean {
  return !!tvdb.poster && /^https?:\/\//.test(tvdb.poster);
}

// Public TVDB page for an entry. Slug is the canonical key; fall back to the
// numeric id when the slug is missing/empty.
function tvdbHomepage(tvdb: TvdbEntry): string {
  const kind = tvdb.type === 'movie' ? 'movies' : 'series';
  const key = tvdb.slug && tvdb.slug.trim() ? tvdb.slug : String(tvdb.id);
  return `https://thetvdb.com/${kind}/${key}`;
}

// Small "TVDB" badge that links to the entry's public page. Renders the
// entry's id inline so users can see which match is linked. noreferrer so
// TVDB can't correlate the click back to us.
function TvdbBadge({ tvdb }: { tvdb: TvdbEntry }) {
  return (
    <a
      href={tvdbHomepage(tvdb)}
      target="_blank"
      rel="noreferrer noopener"
      className="kind-tag tvdb"
      style={{
        textDecoration: 'none',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.04em',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
      title={`thetvdb.com で「${tvdb.title}」を開く`}
    >
      <Icon name="external" size={10} /> TVDB #{tvdb.id}
    </a>
  );
}

function gradientBg(tvdb: TvdbEntry, variant: 'a' | 'b' = 'a'): string {
  const m = variant === 'b' ? 3 : 2;
  return `linear-gradient(145deg, oklch(0.55 0.14 ${tvdb.id % 360}), oklch(0.32 0.11 ${(tvdb.id * m) % 360}))`;
}

function posterStyle(tvdb: TvdbEntry): CSSProperties {
  if (hasPoster(tvdb)) {
    return {
      backgroundImage: `url("${tvdb.poster}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundColor: 'var(--bg-muted)',
    };
  }
  return { background: gradientBg(tvdb) };
}

function heroBgStyle(tvdb: TvdbEntry): CSSProperties {
  // The blurred hero backdrop. Real poster when available; fall back to the
  // gradient. The container CSS already applies blur/opacity so the poster
  // doesn't fight the foreground type.
  if (hasPoster(tvdb)) {
    return {
      backgroundImage: `url("${tvdb.poster}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    };
  }
  return { background: gradientBg(tvdb) };
}

interface MovieHeroProps {
  program: Program;
  tvdb: TvdbMovie;
  ch: Channel;
  onEditTvdb: () => void;
}

function MovieHero({ program, tvdb, ch, onEditTvdb }: MovieHeroProps) {
  const hasJpeg = hasPoster(tvdb);
  const initials =
    (tvdb.titleEn || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(s => s[0])
      .join('')
      .toUpperCase() || 'MV';
  return (
    <div className="movie-hero">
      <div className="movie-hero-bg" style={heroBgStyle(tvdb)} />
      <div className="movie-hero-inner">
        <div className="movie-hero-poster" style={posterStyle(tvdb)}>
          {!hasJpeg && <div className="mh-poster-initials">{initials}</div>}
          <div className="mh-poster-meta">{tvdb.year}</div>
        </div>
        <div className="movie-hero-info">
          <div className="mh-badges">
            <span className="kind-tag movie"><Icon name="sparkle" size={10} /> 映画を認識</span>
            <span className="mh-dot">·</span>
            <TvdbBadge tvdb={tvdb} />
            <TvdbEditIcon onClick={onEditTvdb} linked />
            <span className="mh-dot">·</span>
            <span className="mh-network">{tvdb.network}</span>
          </div>
          <div className="mh-title">{tvdb.title}</div>
          <div className="mh-title-en">{tvdb.titleEn}</div>
          <div className="mh-meta-row">
            <span className="mh-rating">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: '-1px' }}>
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg> {tvdb.rating}
            </span>
            <span className="mh-meta-sep">·</span>
            <span>{tvdb.year}</span>
            <span className="mh-meta-sep">·</span>
            <span>{Math.floor(tvdb.runtime / 60)}時間{tvdb.runtime % 60}分</span>
            <span className="mh-meta-sep">·</span>
            <span>監督 {tvdb.director}</span>
          </div>
          <div className="mh-airing">
            <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{ch.name}</span>
            <span className="mh-meta-sep">·</span>
            <span>{program.start}–{program.end}</span>
            <span className="mh-meta-sep">·</span>
            <span style={{ color: 'var(--fg-muted)' }}>{program.title}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SeriesHeroProps {
  program: Program;
  tvdb: TvdbSeries;
  ch: Channel;
  seriesEps: Program[];
  onEditTvdb: () => void;
}

function SeriesHero({ program, tvdb, ch, seriesEps, onEditTvdb }: SeriesHeroProps) {
  const hasJpeg = hasPoster(tvdb);
  const initials =
    (tvdb.titleEn || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(s => s[0])
      .join('')
      .toUpperCase() || 'TV';
  // Prefer the per-program S/E populated by the server at match time. Fall
  // back to a regex parse of the EPG title when TVDB's episode index didn't
  // cover this airing (common for year-indexed shows airing on a fresh date).
  const epRegex = program.title.match(/第(\d+)回|#(\d+)|ep\.?\s*(\d+)/i);
  const epFromTitle = epRegex ? Number(epRegex[1] || epRegex[2] || epRegex[3]) : null;
  const thisSeason = program.tvdbSeason ?? null;
  const thisEp = program.tvdbEpisode ?? epFromTitle;
  // Only show progress when we have real TVDB episode counts — a known
  // currentEp / totalEps. Otherwise the bar is noise.
  const hasProgressData = tvdb.currentEp > 0 && tvdb.totalEps > 0;
  const progress = hasProgressData
    ? Math.min(100, Math.round((tvdb.currentEp / Math.max(tvdb.totalEps, tvdb.currentEp)) * 100))
    : null;
  // Hide the duplicate English title when it equals the Japanese one
  // (common for Japanese-only shows where TVDB reuses the Japanese name).
  const showTitleEn = tvdb.titleEn && tvdb.titleEn !== tvdb.title;
  const upcoming = seriesEps.length;
  const statusJa = tvdb.status === 'continuing' ? '放送中' : tvdb.status === 'ended' ? '完結' : '放送中';
  const networkYear = tvdb.network
    ? (tvdb.year > 0 ? `${tvdb.network} · ${tvdb.year}年〜` : tvdb.network)
    : (tvdb.year > 0 ? `${tvdb.year}年〜` : '');
  return (
    <div className="series-hero">
      <div className="series-hero-bg" style={heroBgStyle(tvdb)} />
      <div className="series-hero-inner">
        <div className="series-hero-poster" style={posterStyle(tvdb)}>
          {!hasJpeg && <div className="sh-poster-kind">SERIES</div>}
          {!hasJpeg && <div className="sh-poster-initials">{initials}</div>}
          {thisSeason != null && (
            <div className="sh-poster-meta">S{String(thisSeason).padStart(2, '0')}</div>
          )}
        </div>
        <div className="series-hero-info">
          <div className="sh-badges">
            <span className="kind-tag tvdb"><Icon name="sparkle" size={10} /> シリーズ</span>
            <span className="sh-dot">·</span>
            <TvdbBadge tvdb={tvdb} />
            <TvdbEditIcon onClick={onEditTvdb} linked />
            <span className="sh-dot">·</span>
            <span className="sh-status">{statusJa}</span>
            {networkYear && (
              <>
                <span className="sh-dot">·</span>
                <span className="sh-network">{networkYear}</span>
              </>
            )}
          </div>
          <div className="sh-title">{tvdb.title}</div>
          {showTitleEn && <div className="sh-title-en">{tvdb.titleEn}</div>}
          {(thisSeason != null || thisEp != null || tvdb.totalSeasons > 0) && (
            <div className="sh-meta-row">
              {thisSeason != null && thisEp != null ? (
                <span className="sh-ep">
                  <strong>S{thisSeason} · 第{thisEp}話</strong>
                </span>
              ) : thisEp != null ? (
                <span className="sh-ep">第<strong>{thisEp}</strong>話</span>
              ) : null}
              {tvdb.totalSeasons > 0 && (
                <>
                  {(thisSeason != null || thisEp != null) && <span className="sh-meta-sep">·</span>}
                  <span>全{tvdb.totalSeasons}シーズン</span>
                </>
              )}
              {tvdb.totalEps > 0 && (
                <>
                  <span className="sh-meta-sep">·</span>
                  <span>通算{tvdb.totalEps}話</span>
                </>
              )}
            </div>
          )}
          {program.tvdbEpisodeName && (
            <div className="sh-meta-row" style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
              「{program.tvdbEpisodeName}」
            </div>
          )}
          {progress != null && (
            <div
              className="sh-progress"
              title={`世界で ${tvdb.totalEps} 話中 ${tvdb.currentEp} 話放送済 (TVDB集計)`}
            >
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--fg-muted)',
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  marginRight: 4,
                }}
              >
                シリーズ進捗 (TVDB)
              </span>
              <div className="sh-progress-bar">
                <div
                  className="sh-progress-fill"
                  style={{ width: `${progress}%`, background: `linear-gradient(90deg, oklch(0.6 0.14 ${tvdb.id % 360}), oklch(0.7 0.12 ${(tvdb.id + 60) % 360}))` }}
                />
              </div>
              <span className="sh-progress-label">{progress}%</span>
            </div>
          )}
          {upcoming > 1 && (
            <div className="sh-airing">
              <span style={{ color: 'var(--fg-muted)' }}>今後{upcoming}回予定</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ModeCardProps {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  icon: IconName;
  recommended?: boolean;
}

function ModeCard({ active, onClick, title, desc, icon, recommended }: ModeCardProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 3,
        padding: '12px 14px',
        textAlign: 'left',
        border: active ? '1.5px solid var(--accent)' : '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: active ? 'var(--accent-soft)' : 'var(--bg-elev)',
        boxShadow: active ? '0 0 0 2px var(--accent-soft)' : 'none',
        transition: 'all 120ms var(--ease)',
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      {recommended && (
        <span
          style={{
            position: 'absolute',
            top: -6,
            right: 8,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.05em',
            padding: '1px 6px',
            background: 'var(--accent)',
            color: 'white',
            borderRadius: 3,
            fontFamily: 'var(--font-mono)',
          }}
        >
          推奨
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
        <Icon name={icon} size={13} /> {title}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{desc}</div>
    </button>
  );
}

// -----------------------------------------------------------------
// EpgDetails — renders the program description plus the ARIB extended
// descriptor (cast, staff, music, subtitle, …) as a definition list. The
// extended object is passed through verbatim from Mirakurun; keys and
// values are broadcaster-authored strings. Hidden when neither is set.
// -----------------------------------------------------------------

interface EpgDetailsProps { program: Program }

function EpgDetails({ program }: EpgDetailsProps) {
  const ext = program.extended;
  const hasExt = ext && Object.keys(ext).length > 0;
  const hasDesc = !!program.desc;
  const [expanded, setExpanded] = useState(false);
  if (!hasDesc && !hasExt) return null;
  const extEntries: Array<[string, string]> = hasExt ? Object.entries(ext!) : [];

  // Whether the content is worth hiding. When false, everything renders
  // inline with no toggle. When true, a single button flips the entire
  // EpgDetails block between preview (desc first line only) and full.
  const descIsLong = hasDesc && isLongDesc(program.desc!);
  const canCollapse = descIsLong || hasExt;
  const collapsed = canCollapse && !expanded;

  return (
    <div style={{ marginTop: 12 }}>
      <div className={collapsed ? 'epg-details-fade' : undefined}>
        {hasDesc && (
          <div className="modal-desc" style={{ whiteSpace: 'pre-wrap' }}>{program.desc}</div>
        )}
        {hasExt && (
          <dl
            style={{
              marginTop: hasDesc ? 8 : 0,
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              columnGap: 10,
              rowGap: 3,
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            {extEntries.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt style={{ color: 'var(--fg-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</dt>
                <dd
                  style={{ margin: 0, color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {canCollapse && (
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              fontSize: 11,
              padding: 0,
              lineHeight: 1.4,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {expanded ? '閉じる' : 'すべて表示'}
          </button>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// DebugDetailsModal — sibling overlay (z-index above ReserveModal) that
// surfaces the raw EPG fields and the resolved TVDB match context. Useful
// to debug why a TVDB match did or didn't fire, and to see broadcaster-
// provided fields that the hero/title row overrides when a match is
// present. Mirrors TvdbEditModal's backdrop/stopPropagation pattern so
// clicking the backdrop closes only this modal, not the parent.
// -----------------------------------------------------------------

// Threshold above which the EpgDetails block as a whole gets hidden behind
// the "詳細を表示" toggle. Short descriptions render inline with no toggle.
const LONG_DESC_CHARS = 200;

function isLongDesc(v: string): boolean {
  return v.includes('\n') || v.length > LONG_DESC_CHARS;
}

function DebugDetailsTrigger({ onClick }: { onClick: () => void }) {
  return (
    <div style={{ marginTop: 12, textAlign: 'right' }}>
      <button
        type="button"
        onClick={onClick}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--fg-subtle)',
          cursor: 'pointer',
          fontSize: 10.5,
          padding: 0,
          letterSpacing: '0.02em',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
        }}
      >
        EPG / TVDB デバッグ
      </button>
    </div>
  );
}

interface DebugDetailsModalProps {
  program: Program;
  onClose: () => void;
}

function DebugDetailsModal({ program: p, onClose }: DebugDetailsModalProps) {
  const mono: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    wordBreak: 'break-all',
    whiteSpace: 'pre-wrap',
  };
  const row = (label: string, value: ReactNode, monoValue = false) => (
    <div key={label} style={{ display: 'contents' }}>
      <dt
        style={{
          color: 'var(--fg-muted)',
          fontWeight: 600,
          whiteSpace: 'nowrap',
          fontSize: 11,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          color: 'var(--fg)',
          ...(monoValue ? mono : { fontSize: 12, wordBreak: 'break-word' }),
        }}
      >
        {value ?? <span style={{ color: 'var(--fg-subtle)' }}>—</span>}
      </dd>
    </div>
  );

  const tvdb = p.tvdb ?? null;
  const extEntries = p.extended ? Object.entries(p.extended) : [];

  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: 110 }}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        // Only close this sub-modal — don't let the click bubble to the
        // parent ReserveModal's backdrop which would close everything.
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="modal"
        style={{
          width: 'min(720px, 92vw)',
          maxWidth: 'min(720px, 92vw)',
          maxHeight: 'min(80vh, 720px)',
        }}
        onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title" style={{ fontSize: 16 }}>
            詳細情報
          </div>
          <div className="modal-subtitle-row">
            <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
              EPG / TVDB デバッグ — {p.title}
            </span>
          </div>
        </div>

        <div className="modal-body">
          <div
            style={{
              fontSize: 10,
              color: 'var(--fg-subtle)',
              fontWeight: 700,
              letterSpacing: '0.08em',
              marginBottom: 6,
            }}
          >
            EPG
          </div>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              columnGap: 12,
              rowGap: 4,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {row('program.id', p.id ?? null, true)}
            {row('title', p.title)}
            {p.ep != null && row('ep', p.ep)}
            {p.series != null && row('series', <span style={mono}>{p.series}</span>)}
            {row('genre', `${p.genre.label} (${p.genre.key})`)}
            {row('ch', <span style={mono}>{p.ch}</span>)}
            {row(
              'startAt',
              p.startAt ? (
                <>
                  <span style={mono}>{p.startAt}</span>
                  <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontSize: 11 }}>
                    {jpAirDate(p.startAt)}
                  </span>
                </>
              ) : null,
            )}
            {row(
              'endAt',
              p.endAt ? (
                <>
                  <span style={mono}>{p.endAt}</span>
                  <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontSize: 11 }}>
                    {jpAirDate(p.endAt)}
                  </span>
                </>
              ) : null,
            )}
            {p.video && row('video', <span style={mono}>{p.video}</span>)}
            {row('hd', <span style={mono}>{String(!!p.hd)}</span>)}
          </dl>

          {extEntries.length > 0 && (
            <>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--fg-subtle)',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  margin: '10px 0 6px',
                }}
              >
                extended (ARIB)
              </div>
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'max-content 1fr',
                  columnGap: 12,
                  rowGap: 4,
                  margin: 0,
                  fontSize: 11,
                  lineHeight: 1.5,
                }}
              >
                {extEntries.map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt
                      style={{
                        color: 'var(--fg-muted)',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {k}
                    </dt>
                    <dd
                      style={{
                        margin: 0,
                        color: 'var(--fg)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {tvdb && (
            <>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--fg-subtle)',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  margin: '10px 0 6px',
                }}
              >
                TVDB match
              </div>
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'max-content 1fr',
                  columnGap: 12,
                  rowGap: 4,
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                {row('tvdb.id', <span style={mono}>{tvdb.id}</span>)}
                {row('tvdb.slug', <span style={mono}>{tvdb.slug || '—'}</span>)}
                {row('tvdb.title', tvdb.title)}
                {row('tvdb.titleEn', tvdb.titleEn)}
                {row('tvdb.network', tvdb.network || null)}
                {row('tvdb.year', tvdb.year > 0 ? tvdb.year : null)}
                {row('tvdb.matchedBy', <span style={mono}>{tvdb.matchedBy || '—'}</span>)}
                {p.tvdbSeason != null && row('tvdbSeason', <span style={mono}>{p.tvdbSeason}</span>)}
                {p.tvdbEpisode != null && row('tvdbEpisode', <span style={mono}>{p.tvdbEpisode}</span>)}
                {p.tvdbEpisodeName && row('tvdbEpisodeName', p.tvdbEpisodeName)}
              </dl>
            </>
          )}

          {p.desc && (
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                columnGap: 12,
                rowGap: 4,
                margin: '10px 0 0',
                lineHeight: 1.5,
              }}
            >
              {row(
                'desc',
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.desc}</span>,
              )}
            </dl>
          )}
        </div>

        <div className="modal-foot">
          <div className="spacer" />
          <button
            className="btn"
            onClick={(e) => {
              // Stop propagation so the parent ReserveModal's backdrop
              // click handler doesn't fire in addition to closing this
              // sub-modal.
              e.stopPropagation();
              onClose();
            }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// TvdbMatchPanel — expandable drawer at the bottom of the modal body for
// manually searching TVDB + re-pinning the match. Uses the new
// POST/DELETE /programs/:id/tvdb routes. Auto-seeds the search input with
// the program title so the first search is one click away.
// -----------------------------------------------------------------

function TvdbEditIcon({ onClick, linked }: { onClick: () => void; linked: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={linked ? 'TVDB 紐付けを変更' : 'TVDB を検索して紐付け'}
      aria-label={linked ? 'TVDB 紐付けを変更' : 'TVDB を検索'}
      style={{
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: '0 8px',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 6,
        color: linked ? 'var(--fg-muted)' : 'var(--accent)',
        cursor: 'pointer',
        flexShrink: 0,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1,
      }}
    >
      <Icon name={linked ? 'pencil' : 'link'} size={12} />
      <span>{linked ? '紐付けを変更' : '紐付け'}</span>
    </button>
  );
}

interface TvdbEditModalProps {
  program: Program;
  entry: TvdbEntry | null;
  onClose: () => void;
  onChange?: () => void;
}

function TvdbEditModal({ program, entry, onClose, onChange }: TvdbEditModalProps) {
  const [query, setQuery] = useState(program.title);
  const [results, setResults] = useState<ApiTvdbEntry[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'linking' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Seed `picked` from the currently-linked entry so existing links can be
  // tweaked (S/E only) without re-selecting. TvdbEntry (local rich shape) and
  // ApiTvdbEntry (OpenAPI shape) share the minimal fields we read.
  const [picked, setPicked] = useState<ApiTvdbEntry | null>(
    entry ? (entry as unknown as ApiTvdbEntry) : null,
  );

  const [episodes, setEpisodes] = useState<ApiTvdbEpisode[]>([]);
  const [epLoading, setEpLoading] = useState(false);
  const [selSeason, setSelSeason] = useState<number | null>(program.tvdbSeason ?? null);
  const [selEpisode, setSelEpisode] = useState<number | null>(program.tvdbEpisode ?? null);

  // Auto-search on open so users see candidates immediately.
  useEffect(() => {
    void runSearch(program.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progId(program)]);

  // Fetch the cached episode list whenever `picked` points at a series.
  useEffect(() => {
    if (!picked || picked.type !== 'series') {
      setEpisodes([]);
      return;
    }
    let cancelled = false;
    setEpLoading(true);
    api.tvdb
      .listEpisodes(picked.id)
      .then((eps) => {
        if (!cancelled) setEpisodes(eps);
      })
      .catch(() => {
        if (!cancelled) setEpisodes([]);
      })
      .finally(() => {
        if (!cancelled) setEpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [picked]);

  const seasonOpts = Array.from(new Set(episodes.map((ep) => ep.s))).sort(
    (a, b) => a - b,
  );
  const epsForSeason = selSeason != null
    ? episodes.filter((ep) => ep.s === selSeason).sort((a, b) => a.e - b.e)
    : [];

  async function runSearch(q?: string) {
    const term = (q ?? query).trim();
    if (!term) return;
    setState('searching');
    setError(null);
    try {
      const hits = await api.tvdb.search(term);
      setResults(hits);
      setState('idle');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setState('error');
    }
  }

  async function unlink() {
    if (!program.id) {
      setError('API program id missing (fixture-only data?)');
      setState('error');
      return;
    }
    setState('linking');
    setError(null);
    try {
      await api.programs.unlinkTvdb(program.id);
      onChange?.();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setState('error');
    }
  }

  async function save() {
    if (!program.id) {
      setError('API program id missing (fixture-only data?)');
      setState('error');
      return;
    }
    if (!picked) return;
    setState('linking');
    setError(null);
    try {
      if (picked.id !== entry?.id) {
        await api.programs.linkTvdb(program.id, picked.id);
      }
      // Movies have no S/E; for series, send numbers when both are set,
      // otherwise clear.
      if (picked.type === 'series' && selSeason != null && selEpisode != null) {
        await api.programs.setEpisode(program.id, selSeason, selEpisode);
      } else {
        await api.programs.setEpisode(program.id, null, null);
      }
      onChange?.();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setState('error');
    }
  }

  function pickResult(r: ApiTvdbEntry) {
    setPicked(r);
    // Reset S/E when switching to a different entry — the previous values
    // belong to the prior series and don't transfer.
    if (r.id !== picked?.id) {
      setSelSeason(r.id === entry?.id ? (program.tvdbSeason ?? null) : null);
      setSelEpisode(r.id === entry?.id ? (program.tvdbEpisode ?? null) : null);
    }
  }

  const isSeriesPicked = picked?.type === 'series';
  const canSave = picked != null && state !== 'linking';

  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: 110 }}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="modal"
        style={{ maxWidth: 560 }}
        onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title" style={{ fontSize: 16 }}>
            TVDB 紐付け
          </div>
          <div className="modal-subtitle-row">
            <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
              {program.title}
            </span>
          </div>
        </div>

        <div className="modal-body">
          {error && (
            <div style={{ fontSize: 11, color: 'var(--rec)', marginBottom: 8 }}>
              {error}
            </div>
          )}

          <div
            style={{
              fontSize: 10,
              color: 'var(--fg-subtle)',
              fontWeight: 700,
              letterSpacing: '0.08em',
              marginBottom: 6,
            }}
          >
            作品を選択
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
              placeholder="TVDB を検索"
              autoFocus
              style={{
                flex: 1,
                padding: '8px 10px',
                fontSize: 13,
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--bg)',
                color: 'var(--fg)',
              }}
            />
            <button
              className="btn"
              onClick={() => void runSearch()}
              disabled={state === 'searching'}
            >
              {state === 'searching' ? '検索中…' : '検索'}
            </button>
          </div>

          <div
            style={{
              marginTop: 8,
              maxHeight: 260,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            {results.length === 0 && state !== 'searching' && (
              <div style={{ padding: 20, fontSize: 12, color: 'var(--fg-muted)', textAlign: 'center' }}>
                {query.trim() ? '候補なし。別のキーワードで検索してください。' : 'キーワードを入力してください。'}
              </div>
            )}
            {results.map((r) => {
              const selected = picked?.id === r.id;
              return (
                <div
                  key={r.id}
                  onClick={() => pickResult(r)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 12,
                    cursor: 'pointer',
                    background: selected ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--fg-muted)',
                      minWidth: 34,
                    }}
                  >
                    {r.type === 'movie' ? '映画' : 'TV'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.title}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.titleEn} · {r.year || '-'} · {r.network || '-'} · #{r.id}
                    </div>
                  </div>
                  {entry?.id === r.id && (
                    <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
                      現在
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {isSeriesPicked && (
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--fg-subtle)',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                  }}
                >
                  シーズン / 話数
                </span>
                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  任意 (未指定でも保存できます)
                </span>
                {(selSeason != null || selEpisode != null) && (
                  <button
                    type="button"
                    onClick={() => { setSelSeason(null); setSelEpisode(null); }}
                    style={{
                      marginLeft: 'auto',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--fg-muted)',
                      fontSize: 11,
                      cursor: 'pointer',
                      padding: 0,
                      textDecoration: 'underline',
                    }}
                  >
                    クリア
                  </button>
                )}
              </div>
              {epLoading ? (
                <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  エピソード一覧を取得中…
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--fg-muted)' }}>
                    S
                    {seasonOpts.length > 0 ? (
                      <select
                        value={selSeason ?? ''}
                        onChange={(e) => {
                          const v = e.target.value === '' ? null : Number(e.target.value);
                          setSelSeason(v);
                          setSelEpisode(null);
                        }}
                        style={{
                          padding: '4px 8px',
                          fontSize: 12,
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        <option value="">—</option>
                        {seasonOpts.map((s) => (
                          <option key={s} value={s}>S{s}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        placeholder="-"
                        value={selSeason ?? ''}
                        onChange={(e) =>
                          setSelSeason(e.target.value === '' ? null : Number(e.target.value))
                        }
                        style={{
                          width: 64,
                          padding: '4px 8px',
                          fontSize: 12,
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      />
                    )}
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--fg-muted)' }}>
                    E
                    {epsForSeason.length > 0 ? (
                      <select
                        value={selEpisode ?? ''}
                        onChange={(e) =>
                          setSelEpisode(e.target.value === '' ? null : Number(e.target.value))
                        }
                        style={{
                          padding: '4px 8px',
                          fontSize: 12,
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontFamily: 'var(--font-mono)',
                          maxWidth: 320,
                        }}
                      >
                        <option value="">—</option>
                        {epsForSeason.map((ep) => (
                          <option key={ep.e} value={ep.e}>
                            E{ep.e}{ep.name ? ` · ${ep.name}` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        placeholder="-"
                        value={selEpisode ?? ''}
                        onChange={(e) =>
                          setSelEpisode(e.target.value === '' ? null : Number(e.target.value))
                        }
                        style={{
                          width: 64,
                          padding: '4px 8px',
                          fontSize: 12,
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      />
                    )}
                  </label>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          {entry && (
            <button
              className="btn danger"
              onClick={() => void unlink()}
              disabled={state === 'linking'}
            >
              紐付けを解除
            </button>
          )}
          <div className="spacer" />
          <button
            className="btn"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            キャンセル
          </button>
          <button
            className="btn accent"
            onClick={() => void save()}
            disabled={!canSave}
          >
            {state === 'linking' ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
