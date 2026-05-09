// Floating detail/reserve panel for the program guide. Sits anchored to
// the bottom of the viewport in landscape orientation so the guide above
// remains visible — and crucially, clickable — while the panel is open.
// The user can pick another program in the grid and the panel re-keys to
// it without an intervening close. Glass-tinted hero (poster bleed +
// soft fade-to-elev) is preserved from the prior centered modal.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from './Icon';
import { durLabel, getChannel, progId, MOCK_NOW_MIN, toMin } from '../lib/epg';
import { jpAirDate, toProgram } from '../lib/adapters';
import { hasPoster, posterStyle } from '../lib/tvdbVisual';
import { seriesRuleCovers, seriesRuleOnOtherChannel, seriesRuleChannels as seriesRuleChannelsFor } from '../lib/seriesRule';
import { DebugDetailsModal } from './Modal';
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
  existingSeriesIds?: Set<number>;
  /** tvdb ids whose series rule already exists but is currently
   *  disabled. The modal swaps the "シリーズを追加" button for a
   *  gray "シリーズ予約を再開" so the user re-enables the existing
   *  rule instead of POSTing a duplicate (which would 409). */
  disabledSeriesIds?: Set<number>;
  /** Channel-aware series rule lookup. Used to distinguish "this airing
   *  is covered" from "the same series is registered, but on another
   *  channel" so the modal can show two action buttons + a small hint
   *  instead of pretending the airing is auto-reserved. */
  seriesRuleChannels?: Map<number, string[]>;
  recordingIdForProgram?: (programId: string) => string | null;
  onClose: () => void;
  onReserve: (p: Program) => void;
  onCreateRule: (keyword: string, p: Program, channels?: string[]) => void;
  onCreateSeriesLink: (tvdb: TvdbSeries, p: Program, channels?: string[]) => void;
  onUnsubscribeSeries?: (tvdbId: number) => void;
  onResumeSeries?: (tvdbId: number) => void;
  onStopRecording?: (recordingId: string) => void;
  onSelectProgram: (p: Program) => void;
}

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
  existingSeriesIds,
  disabledSeriesIds,
  seriesRuleChannels,
  recordingIdForProgram,
  onClose,
  onReserve,
  onCreateRule,
  onCreateSeriesLink,
  onUnsubscribeSeries,
  onResumeSeries,
  onStopRecording,
  onSelectProgram,
}: InnerProps) {
  const ch = getChannel(channels, program.ch);
  const tvdb: TvdbEntry | null = program.tvdb ?? null;
  const isMovieTvdb = tvdb?.type === 'movie';
  const isSeriesTvdb = tvdb?.type === 'series';
  const isMovieGenre = program.genre.key === 'movie';
  const isMovie = isMovieTvdb || isMovieGenre;
  // Episodes of the same TVDB series. The list comes from a server-wide
  // lookup (not the loaded schedule window) so opening episode 6 surfaces
  // episode 7 even when 7 sits beyond the current 1-week range. The local
  // `programs` prop is only the seed — `useTvdbPrograms` returns the full
  // set keyed on `tvdb.id`.
  const seriesEps = useTvdbPrograms(tvdb?.id ?? null, programs);
  const related = seriesEps
    .filter((p) => progId(p) !== progId(program))
    .sort((a, b) => (a.startAt ?? a.start).localeCompare(b.startAt ?? b.start))
    .slice(0, 8);

  const ext = program.extended ?? null;
  const staff = pickExtendedKv(ext, STAFF_KEYS);
  // Cast comes from TVDB only — the ARIB broadcaster strings are noisy
  // (mixed roles, free-form names) and don't carry headshots, so we don't
  // fall back to them.
  const tvdbCast = useTvdbCast(tvdb?.id ?? null);

  // EPG / TVDB raw-fields modal — re-uses the legacy Modal.tsx
  // `DebugDetailsModal` so the broadcaster's full extended descriptors
  // (cast/staff/music/subtitle/...) and the resolved TVDB context stay
  // inspectable from the new GuidePanel too.
  const [showDebug, setShowDebug] = useState(false);

  // Single source of truth — `program.rec` is set by toProgram() on every
  // refresh against the global recordings list. Using a view-scoped
  // `reservedIds` Set here misses deep-linked programs outside the loaded
  // schedule window (e.g. a related episode 2 weeks ahead opened from
  // another modal), which is what made this state diverge from reality
  // after the user reserved.
  const reserved = !!program.rec;
  const seriesId = tvdb?.id ?? null;
  // "Covered" means: a series rule exists AND its channel list includes
  // this airing's channel (or the list is empty = wildcard). The flat
  // existingSeriesIds Set is too loose — it would mark the BS11 broadcast
  // of an MBS-bound rule as auto-reserved.
  const coveredBySeriesRule =
    seriesId != null && seriesRuleCovers(seriesRuleChannels, seriesId, program.ch);
  // "Same series rule exists, but for a different channel" — we render a
  // small hint and keep both action buttons live so the user can decide.
  const seriesRuledOnOtherChannel =
    seriesId != null && seriesRuleOnOtherChannel(seriesRuleChannels, seriesId, program.ch);
  const otherChannelIds = seriesId != null
    ? seriesRuleChannelsFor(seriesRuleChannels, seriesId).filter((c) => c !== program.ch)
    : [];
  const isLive = toMin(program.start) <= MOCK_NOW_MIN && toMin(program.end) > MOCK_NOW_MIN;
  const apiRecordingId = program.id && recordingIdForProgram
    ? recordingIdForProgram(program.id)
    : null;

  const subtitle =
    isSeriesTvdb && program.tvdbSeason != null && program.tvdbEpisode != null
      ? `S${program.tvdbSeason} · 第${program.tvdbEpisode}話${program.tvdbEpisodeName ? `「${program.tvdbEpisodeName}」` : ''}`
      : program.tvdbEpisodeName ?? program.ep ?? null;

  const hasGlass = !!(tvdb && hasPoster(tvdb));
  const hasExtras =
    !!program.desc || tvdbCast.length > 0 || staff.length > 0 || related.length > 0;
  // Map channel ids in the series-rule's list back to display names so the
  // "他のチャンネルで登録済み" chip / hint can name them. Falls back to
  // the raw id when a channel row has been removed since the rule was
  // created (e.g. tuner reconfig).
  const otherChannelLabels = otherChannelIds.map((id) => {
    const c = getChannel(channels, id);
    return c?.name ?? id;
  });
  const otherChannelLabel = otherChannelLabels.join('・');
  const stateChip = program.recording ? (
    <span className="gp-state-chip rec">
      <span className="gp-state-dot" /> 録画中
    </span>
  ) : coveredBySeriesRule ? (
    <span className="gp-state-chip series">
      <Icon name="cycle" size={10} /> シリーズ予約済
    </span>
  ) : reserved ? (
    <span className="gp-state-chip resv">
      <Icon name="check" size={10} /> 予約済
    </span>
  ) : null;
  // Note: the "他チャンネルで登録済み" meta-chip was removed in favour
  // of a grayed-out informational button rendered inside the action
  // bar (see ActionBar slot 2). Showing both was redundant.

  return (
    <div
      className="guide-panel-floating"
      role="dialog"
      aria-modal="false"
      aria-label="番組詳細"
      data-testid="guide-panel"
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
        className={`gp-main${hasGlass ? ' has-poster' : ''}`}
        style={
          hasGlass
            ? ({ '--gp-hero-bg': `url("${tvdb!.poster}")` } as CSSProperties)
            : undefined
        }
      >
        {hasGlass && (
          <div className="gp-poster" style={posterStyle(tvdb!)} />
        )}

        <div className="gp-content">
        <div className="gp-info">
          <div className="gp-meta-row">
            {/* The "映画 / シリーズ" kind pill was removed (2026-05-09):
               movies are obvious from the genre tag and series from the
               poster bleed, so the pill was just redundant noise. */}
            <span
              className="gp-genre-tag"
              style={{ '--tag-dot': program.genre.dot } as CSSProperties}
            >
              <span className="gp-genre-dot" />
              {program.genre.label}
            </span>
            {stateChip}
            <span className="gp-meta-sep">·</span>
            <span className="gp-time">{program.start}–{program.end}</span>
            <span className="gp-meta-sep">·</span>
            <span>{durLabel(program)}</span>
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
            {tvdb?.network && (
              <>
                <span className="gp-meta-sep">·</span>
                <span>{tvdb.network}</span>
              </>
            )}
          </div>
        </div>

        <div className="gp-action-row">
          <ActionBar
            program={program}
            tvdb={tvdb}
            isMovie={isMovie}
            isSeriesTvdb={isSeriesTvdb}
            isLive={isLive}
            reserved={reserved}
            coveredBySeriesRule={coveredBySeriesRule}
            seriesRuleDisabled={
              tvdb?.type === 'series' && !!disabledSeriesIds && disabledSeriesIds.has(tvdb.id)
            }
            seriesRuledOnOtherChannel={seriesRuledOnOtherChannel}
            otherChannelLabel={otherChannelLabel}
            apiRecordingId={apiRecordingId}
            onReserve={onReserve}
            onCreateRule={onCreateRule}
            onCreateSeriesLink={onCreateSeriesLink}
            onUnsubscribeSeries={onUnsubscribeSeries}
            onResumeSeries={onResumeSeries}
            onStopRecording={onStopRecording}
          />
          {!reserved && !coveredBySeriesRule && (
            <ReserveOutcome
              tvdb={tvdb}
              seriesAlreadyRuled={
                isSeriesTvdb && tvdb && !!existingSeriesIds && existingSeriesIds.has(tvdb.id)
              }
              seriesOnOtherChannelLabel={
                seriesRuledOnOtherChannel ? otherChannelLabel || '他チャンネル' : null
              }
            />
          )}
        </div>
        </div>
      </div>

      {hasExtras && (
        <div className="gp-extras">
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
      )}

      <div className="gp-debug-row">
        <button
          type="button"
          className="gp-debug-trigger"
          onClick={() => setShowDebug(true)}
        >
          EPG / TVDB デバッグ
        </button>
      </div>

      {showDebug && (
        <DebugDetailsModal
          program={program}
          recordingId={apiRecordingId}
          onClose={() => setShowDebug(false)}
        />
      )}
    </div>
  );
}

// Description for the "シリーズを追加" button. Counting only the loaded
// schedule (this week's EPG window) misleads the user — a 12-episode
// anime reads "全1回" if only the next airing is in range. Lean on
// TVDB's series-wide aggregates so the message conveys both the
// committed count for completed series and current progress for
// ongoing ones.
function seriesAddDesc(tvdb: TvdbEntry | null): string {
  if (!tvdb || tvdb.type !== 'series') return '';
  const total = tvdb.totalEps ?? 0;
  const seasons = tvdb.totalSeasons ?? 0;
  const curSeason = tvdb.currentSeason ?? 0;
  const curEp = tvdb.currentEp ?? 0;
  const ongoing = tvdb.status === 'continuing';
  if (ongoing) {
    if (seasons > 1 && curSeason > 0 && curEp > 0) {
      return `S${curSeason} 第${curEp}話まで · 毎週自動`;
    }
    if (curEp > 0) return `第${curEp}話まで · 毎週自動`;
    return total > 0 ? `現在${total}話 · 毎週自動` : '毎週自動で予約';
  }
  if (seasons > 1 && total > 0) return `${seasons}シーズン ${total}話`;
  return total > 0 ? `全${total}話を自動で予約` : '今後の放送を自動で予約';
}

interface ActionBarProps {
  program: Program;
  tvdb: TvdbEntry | null;
  isMovie: boolean;
  isSeriesTvdb: boolean;
  isLive: boolean;
  reserved: boolean;
  coveredBySeriesRule: boolean;
  // True when a series rule for this tvdb exists but is currently
  // disabled. Drives a gray "シリーズ予約を再開" affordance instead of
  // "シリーズを追加" (which would 409 against the unique tvdb_id).
  seriesRuleDisabled: boolean;
  // True when a series rule exists for this tvdb but its channel list
  // does not include this airing's channel. Slot 2 collapses to a
  // disabled "{channel}で登録済み" indicator so the user can see at a
  // glance the series is already booked elsewhere — no double-add.
  seriesRuledOnOtherChannel: boolean;
  // Display label of the channel(s) the rule is registered on. When
  // seriesRuledOnOtherChannel is true this fills the disabled button.
  otherChannelLabel: string;
  apiRecordingId: string | null;
  onReserve: (p: Program) => void;
  onCreateRule: (keyword: string, p: Program, channels?: string[]) => void;
  onCreateSeriesLink: (tvdb: TvdbSeries, p: Program, channels?: string[]) => void;
  onUnsubscribeSeries?: (tvdbId: number) => void;
  onResumeSeries?: (tvdbId: number) => void;
  onStopRecording?: (recordingId: string) => void;
}

// Single horizontal action bar that morphs by state — the user sees the
// same two slots whether the program is unreserved, reserved, or live;
// only the buttons' colour + text change. Eliminates the old ReserveBlock /
// ReservedBlock fork (different layouts) so reservation toggles never
// rearrange the surrounding UI.
function ActionBar(props: ActionBarProps) {
  const {
    program,
    tvdb,
    isMovie,
    isSeriesTvdb,
    isLive,
    reserved,
    coveredBySeriesRule,
    seriesRuleDisabled,
    seriesRuledOnOtherChannel,
    otherChannelLabel,
    apiRecordingId,
    onReserve,
    onCreateRule,
    onCreateSeriesLink,
    onUnsubscribeSeries,
    onResumeSeries,
    onStopRecording,
  } = props;

  // --- Slot 1: this-airing (single recording / live stop) -----------------
  const stopAvailable = isLive && apiRecordingId != null && !!onStopRecording;
  const slot1: ActionCardSpec = (() => {
    if (isLive && stopAvailable) {
      return {
        title: '録画停止',
        desc: '今すぐ停止',
        kind: 'danger',
        onClick: () => onStopRecording!(apiRecordingId!),
      };
    }
    if (reserved && !coveredBySeriesRule) {
      return {
        title: 'この回の予約取消',
        desc: '単発予約を解除',
        kind: 'danger',
        onClick: () => onReserve(program),
      };
    }
    if (reserved && coveredBySeriesRule) {
      // The series rule covers it AND a once-recording exists too — let
      // the user drop the once-recording without breaking the series rule.
      return {
        title: 'この回の予約取消',
        desc: 'シリーズ予約は維持',
        kind: 'danger',
        onClick: () => onReserve(program),
      };
    }
    return {
      // Movies have no "回" concept — say plain "録画". Series/shows
      // keep "この回のみ録画" so the user can distinguish the single-
      // airing recording from a series-rule auto-reservation.
      title: isMovie ? '録画' : 'この回のみ録画',
      desc: `${program.start}–${program.end}`,
      // For movies "録画" IS the primary action (no "シリーズを追加"
      // alternative to compete with), so render it filled blue. For
      // series/shows it stays ghost — the primary slot is the series-
      // add button next to it.
      kind: isMovie ? 'primary' : 'ghost',
      onClick: () => onReserve(program),
    };
  })();

  // --- Slot 2: series rule (only when applicable) -------------------------
  // Once the program is already reserved or being recorded, the actionable
  // path collapses to a single CTA — either "この回を取消" (slot1, single
  // booking) OR "シリーズ予約解除" (slot2, broader rule). Showing both
  // buttons crowds the modal without adding new actions, so we hide the
  // non-driving slot.
  const slot2: ActionCardSpec | null = (() => {
    if (isMovie) return null; // movies have no series concept
    if (isSeriesTvdb && tvdb && tvdb.type === 'series') {
      if (coveredBySeriesRule) {
        return {
          title: 'シリーズ予約解除',
          desc: '今後の自動予約を停止',
          // Orange — matches the series-registered active state shown
          // on the cells and the meta-row chip.
          kind: 'series',
          onClick: onUnsubscribeSeries
            ? () => onUnsubscribeSeries(tvdb.id)
            : undefined,
        };
      }
      // Series rule exists on a different channel — render a single
      // disabled "{ch}で登録済み" button. ActionCard auto-applies the
      // native `disabled` HTML attribute when onClick is undefined, so
      // the button is non-interactive (no onClick, no double-add risk).
      // Replaces the prior meta-row chip + "シリーズを追加" pair.
      if (seriesRuledOnOtherChannel) {
        return {
          title: `${otherChannelLabel || '他チャンネル'}で登録済み`,
          desc: 'シリーズ自動予約',
          kind: 'ghost',
          onClick: undefined,
        };
      }
      // Disabled-rule path: an existing rule is sitting in the table
      // but with enabled=false. Render a gray (off-state) toggle that
      // re-enables it instead of trying to POST a new rule (which
      // would 409 the unique tvdb_id constraint).
      if (seriesRuleDisabled) {
        return {
          title: 'シリーズ予約を再開',
          desc: '現在オフ',
          kind: 'ghost',
          onClick: onResumeSeries ? () => onResumeSeries(tvdb.id) : undefined,
        };
      }
      // Covered by neither single nor series — recommend series-add.
      // While the user is in a single-only reservation we hide this so
      // only the cancel CTA remains.
      if (reserved) return null;
      return {
        title: 'シリーズを追加',
        desc: seriesAddDesc(tvdb),
        kind: 'primary',
        onClick: () => onCreateSeriesLink(tvdb, program, [program.ch]),
      };
    }
    if (!tvdb) {
      // For non-TVDB programs, a single reservation already implies a
      // separate keyword rule decision — collapse to one button when the
      // user has reserved.
      if (reserved) return null;
      return {
        title: '自動予約ルール',
        desc: '同じ番組を今後も自動録画',
        kind: 'ghost',
        onClick: () => onCreateRule(program.title.slice(0, 14), program, [program.ch]),
      };
    }
    return null;
  })();

  // Slot 1 is suppressed when the series-rule path is the only meaningful
  // action: a single-booking cancel is meaningless once a series rule
  // covers the airing (the rule will just re-expand a fresh recording),
  // so the user is really managing the series. Live recordings keep
  // slot1 because that's where the stop button lives.
  const slot1Hidden = coveredBySeriesRule && !isLive;
  // While recording is live, the only sensible slot1 is "停止"; nothing
  // belongs in slot2 on top of that.
  const slot2Hidden = isLive;

  return (
    <div className="gp-actions">
      {!slot1Hidden && <ActionCard {...slot1} />}
      {slot2 && !slot2Hidden && <ActionCard {...slot2} />}
    </div>
  );
}

interface ReserveOutcomeProps {
  tvdb: TvdbEntry | null;
  seriesAlreadyRuled: boolean;
  // Non-null = a series rule for this tvdb exists, but only on other
  // channels (this airing isn't auto-reserved). Suppressed here — the
  // disabled "{ch}で登録済み" button in the action bar already conveys
  // it; a second hint in the action area was redundant.
  seriesOnOtherChannelLabel: string | null;
}

// Inline hint that surfaces under the action bar before reservation —
// only when the rule outcome wouldn't be obvious from the action labels.
// The movie-specific branches ("ライブラリの映画タブに追加" / "TVDB 紐付け
// なしのため再放送自動予約はない") were dropped 2026-05-09: both are
// inferable from the genre tag + the absence of any series-add button,
// so the hints just added noise.
function ReserveOutcome({
  tvdb,
  seriesAlreadyRuled,
  seriesOnOtherChannelLabel,
}: ReserveOutcomeProps) {
  if (seriesOnOtherChannelLabel) return null;
  if (seriesAlreadyRuled && tvdb) {
    return (
      <div className="gp-outcome accent">
        <Icon name="check" size={12} />
        <div>
          シリーズ「{tvdb.title}」は自動予約済み。
          この回は <strong>「この回のみ」</strong> で上書き予約できます。
        </div>
      </div>
    );
  }
  return null;
}

type ActionKind = 'ghost' | 'primary' | 'danger' | 'series';

interface ActionCardSpec {
  title: string;
  desc: string;
  kind: ActionKind;
  onClick?: () => void;
}

interface ActionCardProps extends ActionCardSpec {}

function ActionCard({ onClick, title, desc, kind }: ActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`gp-mode-card ${kind}`}
    >
      <span className="gp-mode-title">{title}</span>
      <span className="gp-mode-desc">{desc}</span>
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


// ARIB 拡張ディスクリプタから既知キーを順に拾って key/value タプル化。
// 出演者は使わない（TVDB cast に統一）。スタッフ系のみ。
function pickExtendedKv(
  ext: Record<string, string> | null,
  keys: string[],
): Array<[string, string]> {
  if (!ext) return [];
  return keys.flatMap((k) => (ext[k] ? [[k, ext[k]] as [string, string]] : []));
}

// Lookup *every* program matched to a TVDB id — not just what's in the
// current schedule window. Seeds with the parent's already-loaded
// `programs` (filtered by tvdb id) so the list renders immediately, then
// replaces it with the server-wide result the moment GET /tvdb/:id/programs
// returns and *locks* to that result for as long as the tvdbId stays the
// same. The lock matters: when the user reserves a program, the parent
// re-renders `programs` (recordings changed → reservedIds re-derives →
// new program objects), and a naive seed-on-every-render would reset eps
// back to the schedule window and visually drop the wider series view.
function useTvdbPrograms(tvdbId: number | null, seed: Program[]): Program[] {
  const [eps, setEps] = useState<Program[]>(() =>
    tvdbId == null ? [] : seed.filter((p) => p.tvdb?.id === tvdbId),
  );
  // Tracks the tvdbId we've already issued an API call for, so seed-only
  // re-renders (parent programs prop churn) don't trigger a re-seed.
  const lockedFor = useRef<number | null>(null);
  useEffect(() => {
    if (tvdbId == null) {
      setEps([]);
      lockedFor.current = null;
      return;
    }
    if (lockedFor.current === tvdbId) return;
    // Switching to a new tvdbId — show the seed immediately while the API
    // call below fills in episodes outside the loaded window.
    setEps(seed.filter((p) => p.tvdb?.id === tvdbId));
    let cancelled = false;
    api.tvdb
      .listPrograms(tvdbId)
      .then((rows) => {
        if (cancelled) return;
        lockedFor.current = tvdbId;
        // Re-use the shared adapter so the toProgram → Program mapping
        // matches the rest of the app. reservedIds is empty here — the
        // related list only renders title/time so flags don't matter.
        setEps(rows.map((r) => toProgram(r, new Set<string>(), new Date())));
      })
      .catch(() => {
        // keep the seed as fallback
      });
    return () => {
      cancelled = true;
    };
    // `seed` intentionally excluded — see lockedFor / comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tvdbId]);
  return eps;
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

