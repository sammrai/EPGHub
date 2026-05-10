// Floating detail/reserve panel for the program guide. Sits anchored to
// the bottom of the viewport in landscape orientation so the guide above
// remains visible — and crucially, clickable — while the panel is open.
// The user can pick another program in the grid and the panel re-keys to
// it without an intervening close. Glass-tinted hero (poster bleed +
// soft fade-to-elev) is preserved from the prior centered modal.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from './Icon';
import { durLabel, getChannel, progId, MOCK_NOW_MIN, toMin } from '../lib/epg';
import { jpAirDate, toProgram } from '../lib/adapters';
import { hasPoster, posterStyle } from '../lib/tvdbVisual';
import { seriesRuleCovers, seriesRuleOnOtherChannel, seriesRuleChannels as seriesRuleChannelsFor } from '../lib/seriesRule';
import { channelKey } from '../lib/channelKey';
import { DebugDetailsModal, RematchButton } from './Modal';
import { api } from '../api/epghub';
import type { ApiTvdbCastMember } from '../api/epghub';
import type {
  Channel,
  Program,
  Rule,
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
  /** Resolve the keyword rule that originally created the reservation
   *  for `programId`, or null. Backed by `recording.source` (kind='rule',
   *  ruleId) on the recordings list — only programs that are actually
   *  reserved-by-rule resolve to a Rule, so the action bar's "ルール解除"
   *  affordance never fires on a random title that happens to share a
   *  substring with a broad keyword (e.g. ニュース). */
  keywordRuleForProgram?: (programId: string) => Rule | null;
  /** Disabled keyword rules. The modal scans these for one whose
   *  `keyword` is a substring of `program.title` (and whose channel list
   *  covers `program.ch`); when found, the action bar swaps "自動予約
   *  ルール" → "ルール予約を再開" so the user re-enables the existing
   *  rule instead of creating a duplicate. Disabled rules don't write
   *  recording rows so the enabled-path's recording.source逆引きは
   *  使えず、こちらだけは substring スキャンで判定する。 */
  disabledKeywordRules?: Rule[];
  recordingIdForProgram?: (programId: string) => string | null;
  /** Called by the debug modal's 再マッチ button after a successful
   *  re-match so the parent re-fetches the schedule and propagates
   *  fresh tvdbSeason / tvdbEpisode back through props. */
  onRefresh?: () => void | Promise<void>;
  onClose: () => void;
  onReserve: (p: Program) => void;
  onCreateRule: (keyword: string, p: Program, channels?: string[]) => void;
  onCreateSeriesLink: (tvdb: TvdbSeries, p: Program, channels?: string[]) => void;
  onUnsubscribeSeries?: (tvdbId: number) => void;
  onUnsubscribeKeyword?: (ruleId: number) => void;
  onResumeSeries?: (tvdbId: number) => void;
  onResumeKeyword?: (ruleId: number) => void;
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
  keywordRuleForProgram,
  disabledKeywordRules,
  recordingIdForProgram,
  onRefresh,
  onClose,
  onReserve,
  onCreateRule,
  onCreateSeriesLink,
  onUnsubscribeSeries,
  onUnsubscribeKeyword,
  onResumeSeries,
  onResumeKeyword,
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
  const related = (() => {
    // Same airing on parallel channel sources (svc-/m3u-) appears twice in
    // useTvdbPrograms because they're distinct channel rows. Collapse by
    // (channelKey, startAt) so only one entry shows per actual broadcast.
    // The current program's own (channelKey, startAt) is pre-seeded so the
    // m3u-/svc- twin of *this* airing doesn't show up as a "related" row.
    const seen = new Set<string>();
    seen.add(`${channelKey(program.ch)}-${program.startAt ?? program.start}`);
    const out: Program[] = [];
    const sorted = seriesEps
      .filter((p) => progId(p) !== progId(program))
      .sort((a, b) => (a.startAt ?? a.start).localeCompare(b.startAt ?? b.start));
    for (const p of sorted) {
      const key = `${channelKey(p.ch)}-${p.startAt ?? p.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out.slice(0, 8);
  })();

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

  // 「自動予約ルール」ボタン用の推定キーワードと、そのキーワードでヒット
  // する未来番組リスト。両方サーバ側 (matchService の CUT_AT_* 正規表現 +
  // 件数判定) で計算する。`matches` はフロントの schedule 窓を超えた範囲
  // (典型: 来週の同番組) も含むので、プレビュー popover の「予約される
  // 番組」がこの回1件だけに見える問題を解消する。届くまでは title.slice
  // フォールバックで仮表示。
  const [ruleKeyword, setRuleKeyword] = useState<string | null>(null);
  const [ruleMatches, setRuleMatches] = useState<Program[]>([]);
  useEffect(() => {
    if (!program.id) {
      setRuleKeyword(null);
      setRuleMatches([]);
      return;
    }
    let cancelled = false;
    setRuleKeyword(null);
    setRuleMatches([]);
    api.programs
      .ruleKeyword(program.id)
      .then((r) => {
        if (cancelled) return;
        setRuleKeyword(r.keyword);
        // server-wide matches を Program 形に揃える。reservedIds は要らない
        // (プレビューは titel/time/ch しか描画しない) ので空 Set で OK。
        setRuleMatches(
          r.matches.map((p) => toProgram(p, new Set<string>(), new Date())),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setRuleKeyword(null);
        setRuleMatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [program.id]);

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
  // Same numeric service id (svc- / m3u- 双方) は「同じチャンネル」扱い。
  // strict `!==` だと M3U 由来で登録したルールに対して Mirakurun 由来の
  // 同一局放送が「他チャンネルで登録済み」と表示されてしまう。
  const programChKey = channelKey(program.ch);
  const otherChannelIds = seriesId != null
    ? seriesRuleChannelsFor(seriesRuleChannels, seriesId).filter(
        (c) => channelKey(c) !== programChKey,
      )
    : [];
  const isLive = toMin(program.start) <= MOCK_NOW_MIN && toMin(program.end) > MOCK_NOW_MIN;
  const isPast = !!program.endAt && Date.parse(program.endAt) < Date.now();
  const apiRecordingId = program.id && recordingIdForProgram
    ? recordingIdForProgram(program.id)
    : null;

  // 当該番組の予約レコーディング行が `source = { kind:'rule', ruleId }` を
  // 持つなら、それを作ったキーワードルールを引く。ruleExpander が予約時
  // にちゃんと紐付けて DB に書いているので、文字列の総当たりではなく
  // 「この予約を作ったルールそのもの」を一意に特定できる。シリーズ予約の
  // `coveredBySeriesRule` と意味的に対称な、実データ駆動の被覆判定。
  const coveringKeywordRule: Rule | null = program.id
    ? keywordRuleForProgram?.(program.id) ?? null
    : null;

  // disabled キーワードルールの被覆判定。disabled なルールは recording を
  // 作らないので enabled 側の recording.source 経由では引けず、ここだけは
  // substring + チャンネル制限の総当たりで拾う。複数該当した場合は最初の
  // 1件 (再開アクションは ruleId 単位なのでモーダル再表示で残りも個別に
  // 操作可能)。enabled の coveringKeywordRule が存在するときはそちらが
  // 優先 — 解除/再開の二重ボタンを出さない。
  const coveringDisabledKeywordRule = useMemo<Rule | null>(() => {
    if (coveringKeywordRule) return null;
    if (!disabledKeywordRules || disabledKeywordRules.length === 0) return null;
    for (const r of disabledKeywordRules) {
      if (!r.keyword || !program.title.includes(r.keyword)) continue;
      if (r.channels.length === 0) return r;
      if (r.channels.some((c) => channelKey(c) === programChKey)) return r;
    }
    return null;
  }, [coveringKeywordRule, disabledKeywordRules, program.title, programChKey]);

  // 「ルール解除」ボタン横▼のプレビュー用、当該キーワードルールが向こう
  // 14日に拾う番組リスト。フロントの schedule 窓 (~10日) では足りない
  // ケースがあるのでサーバ /rules/:id/matches を叩く。ruleExpander の
  // rulePredicate を使うので ngKeywords / skipReruns / channel 制限まで
  // 反映される。
  const coveringRuleId = coveringKeywordRule?.id ?? null;
  const [coveringRuleMatches, setCoveringRuleMatches] = useState<Program[]>([]);
  useEffect(() => {
    if (coveringRuleId == null) {
      setCoveringRuleMatches([]);
      return;
    }
    let cancelled = false;
    setCoveringRuleMatches([]);
    api.rules
      .matches(coveringRuleId)
      .then((r) => {
        if (cancelled) return;
        setCoveringRuleMatches(
          r.matches.map((p) => toProgram(p, new Set<string>(), new Date())),
        );
      })
      .catch(() => {
        if (!cancelled) setCoveringRuleMatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [coveringRuleId]);

  const subtitle =
    isSeriesTvdb && program.tvdbSeason != null && program.tvdbEpisode != null
      ? `S${program.tvdbSeason} · 第${program.tvdbEpisode}話${program.tvdbEpisodeName ? `「${program.tvdbEpisodeName}」` : ''}`
      : program.tvdbEpisodeName ?? program.ep ?? null;

  const hasGlass = !!(tvdb && hasPoster(tvdb));
  const links = useMemo(() => extractLinks(ext), [ext]);
  const hasExtras =
    !!program.desc || links.length > 0 || tvdbCast.length > 0 || staff.length > 0 || related.length > 0;
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
      className={`guide-panel-floating${hasGlass ? ' has-poster' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label="番組詳細"
      data-testid="guide-panel"
      style={
        hasGlass
          ? ({ '--gp-hero-bg': `url("${tvdb!.poster}")` } as CSSProperties)
          : undefined
      }
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

      <div className="gp-scroll">
      <div className="gp-main">
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
          {(subtitle || program.id) && (
            <div className="gp-subtitle">
              {subtitle && <span>{subtitle}</span>}
              {program.id && (
                <RematchButton
                  programId={program.id}
                  onRefresh={onRefresh}
                  variant="subtle"
                />
              )}
            </div>
          )}

          <div className="gp-channel-row">
            {ch && (
              <span className="gp-channel">
                <span className="gp-channel-dot" style={{ background: ch.color }} />
                {ch.name}
              </span>
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
            isPast={isPast}
            reserved={reserved}
            coveredBySeriesRule={coveredBySeriesRule}
            seriesRuleDisabled={
              tvdb?.type === 'series' && !!disabledSeriesIds && disabledSeriesIds.has(tvdb.id)
            }
            seriesRuledOnOtherChannel={seriesRuledOnOtherChannel}
            otherChannelLabel={otherChannelLabel}
            apiRecordingId={apiRecordingId}
            seriesEps={seriesEps}
            programs={programs}
            channels={channels}
            ruleKeyword={ruleKeyword}
            ruleMatches={ruleMatches}
            coveringKeywordRule={coveringKeywordRule}
            coveringDisabledKeywordRule={coveringDisabledKeywordRule}
            coveringRuleMatches={coveringRuleMatches}
            onReserve={onReserve}
            onCreateRule={onCreateRule}
            onUnsubscribeKeyword={onUnsubscribeKeyword}
            onResumeKeyword={onResumeKeyword}
            onCreateSeriesLink={onCreateSeriesLink}
            onUnsubscribeSeries={onUnsubscribeSeries}
            onResumeSeries={onResumeSeries}
            onStopRecording={onStopRecording}
          />
          {!reserved && !coveredBySeriesRule && !isPast && (
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

      <div className="gp-extras">
        {hasExtras && (
          <>
          {(program.desc || links.length > 0) && (
            <Section title="あらすじ">
              {program.desc && <p className="gp-desc">{program.desc}</p>}
              {links.length > 0 && (
                <div className="gp-links">
                  {links.map((l) => (
                    <LinkChip key={l.url} link={l} />
                  ))}
                </div>
              )}
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
                  const se =
                    rel.tvdbSeason != null && rel.tvdbEpisode != null
                      ? `S${rel.tvdbSeason}E${rel.tvdbEpisode}`
                      : null;
                  const sameCh = channelKey(rel.ch) === programChKey;
                  return (
                    <li key={progId(rel)}>
                      <button
                        type="button"
                        className={`gp-related-item${sameCh ? ' same-ch' : ''}`}
                        onClick={() => onSelectProgram(rel)}
                      >
                        <div className="gp-related-when">
                          {rel.startAt ? jpAirDate(rel.startAt).slice(5, 14) : rel.start}
                        </div>
                        <div className="gp-related-main">
                          <div className="gp-related-title">{rel.title}</div>
                          <div className="gp-related-meta">
                            {sameCh && <span className="gp-related-same-ch">同じチャンネル</span>}
                            <span>{rch?.name ?? rel.ch}</span>
                            <span className="gp-meta-sep">·</span>
                            <span>{rel.start}–{rel.end}</span>
                          </div>
                        </div>
                        {se && <div className="gp-related-se">{se}</div>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
          </>
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
      </div>
      </div>

      {showDebug && (
        <DebugDetailsModal
          program={program}
          recordingId={apiRecordingId}
          onRefresh={onRefresh}
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
  isPast: boolean;
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
  // Episodes loaded for this tvdb id (server-wide). Used by the
  // "シリーズを追加" split-button to preview which airings the rule
  // would actually reserve before the user commits.
  seriesEps: Program[];
  // All programs currently loaded into the guide (the same array the
  // schedule view drives). Used by the keyword-rule preview path —
  // when the airing has no TVDB linkage we fall back to a substring
  // match against this list so "自動予約ルール" can still show what
  // it would catch.
  programs: Program[];
  channels: Channel[];
  // Server-derived auto-rule keyword (件数判定込み)。null の間は title.slice
  // フォールバック、解決後は「Ｎスタ」など正しい候補。詳細は GuidePanel
  // 側の useEffect (api.programs.ruleKeyword) を参照。
  ruleKeyword: string | null;
  // 同 API の `matches` フィールド: 推定キーワードでヒットする未来番組。
  // フロントの schedule 窓を超えた範囲も含むので、プレビュー popover が
  // この回1件だけに見える問題を解消する。
  ruleMatches: Program[];
  // この予約を作ったキーワードルール (recording.source.ruleId 由来)。
  // null = この番組はルール由来ではない (= 単発予約 or 未予約)。
  coveringKeywordRule: Rule | null;
  // disabled キーワードルールが substring + ch でこの番組を被覆して
  // いれば渡る。enabled 側 (coveringKeywordRule) と同時に立つことはなく、
  // どちらかだけが non-null。slot2 を「ルール予約を再開」に変身させる。
  coveringDisabledKeywordRule: Rule | null;
  // 上記ルールが向こう14日に拾う番組リスト (サーバ /rules/:id/matches)。
  // 「ルール解除」ボタン横▼のプレビューに使う。空配列 = 取得中 or 該当
  // ルール無しで、その場合プレビューはローカル schedule から仮表示する。
  coveringRuleMatches: Program[];
  onReserve: (p: Program) => void;
  onCreateRule: (keyword: string, p: Program, channels?: string[]) => void;
  onCreateSeriesLink: (tvdb: TvdbSeries, p: Program, channels?: string[]) => void;
  onUnsubscribeSeries?: (tvdbId: number) => void;
  onUnsubscribeKeyword?: (ruleId: number) => void;
  onResumeSeries?: (tvdbId: number) => void;
  onResumeKeyword?: (ruleId: number) => void;
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
    isPast,
    reserved,
    coveredBySeriesRule,
    seriesRuleDisabled,
    seriesRuledOnOtherChannel,
    otherChannelLabel,
    apiRecordingId,
    seriesEps,
    programs,
    channels,
    ruleKeyword,
    ruleMatches,
    coveringKeywordRule,
    coveringDisabledKeywordRule,
    coveringRuleMatches,
    onReserve,
    onCreateRule,
    onCreateSeriesLink,
    onUnsubscribeSeries,
    onUnsubscribeKeyword,
    onResumeSeries,
    onResumeKeyword,
    onStopRecording,
  } = props;

  // サーバの推定キーワードが未到着なら最アグレッシブな先頭スライスで仮表示。
  // 実害は preview popover が早めに小さい候補で動く程度で、ボタン押下時には
  // 大抵 ruleKeyword が解決済み。
  const effectiveKeyword = ruleKeyword ?? program.title.slice(0, 14).trim();

  // --- Slot 1: this-airing (single recording / live stop) -----------------
  const isRecordingNow = !!program.recording || isLive;
  const stopAvailable = isRecordingNow && apiRecordingId != null && !!onStopRecording;
  const slot1: ActionCardSpec = (() => {
    // Currently recording — always frame the destructive action as "録画
    // 停止", never "予約取消". Whether we go through onStopRecording (the
    // dedicated stop endpoint) or fall back to onReserve (which cancels
    // the reservation row, which the recorder also treats as a stop)
    // the user-visible verb is the same: stop the recording.
    if (isRecordingNow && reserved) {
      return {
        title: '録画停止',
        desc: '今すぐ停止',
        kind: 'danger',
        onClick: stopAvailable
          ? () => onStopRecording!(apiRecordingId!)
          : () => onReserve(program),
      };
    }
    if (reserved && !coveredBySeriesRule && !coveringKeywordRule) {
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
    if (reserved && coveringKeywordRule) {
      // 自動予約ルール由来。この回だけキャンセルしても次回以降はルールが
      // 拾い直すので、シリーズ予約と同じく「ルール予約は維持」と明示。
      return {
        title: 'この回の予約取消',
        desc: 'ルール予約は維持',
        kind: 'danger',
        onClick: () => onReserve(program),
      };
    }
    return {
      // Live airing → recording starts immediately, so call it that.
      // Otherwise: movies have no "回" concept (plain "録画"); series/
      // shows keep "この回のみ録画" so the user can distinguish the
      // single-airing recording from a series-rule auto-reservation.
      title: isLive ? '今すぐ録画' : isMovie ? '録画' : 'この回のみ録画',
      // The live-airing button shows the remaining duration so the user
      // knows how much footage they'll capture if they hit it now.
      desc: isLive
        ? `〜${program.end} まで`
        : `${program.start}–${program.end}`,
      // For movies "録画" IS the primary action (no "シリーズを追加"
      // alternative to compete with), so render it filled blue. For
      // series/shows it stays ghost — the primary slot is the series-
      // add button next to it. Live airings get the primary treatment
      // too — "今すぐ" implies time-pressure so it should grab the eye.
      kind: isLive || isMovie ? 'primary' : 'ghost',
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
      // この予約をキーワードルールが作ったケース → シリーズ予約解除と
      // 同じ系統の「ルール解除」ボタンに変身。ボタン名にキーワードを
      // 出すのは broad keyword (例: 「ニュース」) を消すと巻き添えが大きい
      // ので、何を消すか一目で分かるようにしておく。
      if (coveringKeywordRule) {
        return {
          title: `「${coveringKeywordRule.keyword}」のルール解除`,
          desc: '今後の自動予約を停止',
          kind: 'series',
          onClick: onUnsubscribeKeyword
            ? () => onUnsubscribeKeyword(coveringKeywordRule.id)
            : undefined,
        };
      }
      // disabled なルールがこの番組をカバーしているケース → シリーズ側
      // の「シリーズ予約を再開 / 現在オフ」と対称な再開トグル。新規
      // POST すると同じ keyword でルール被りになるリスクがあるので、
      // 必ず既存ルールの enabled を true に切り替える経路を通す。
      if (coveringDisabledKeywordRule) {
        return {
          title: `「${coveringDisabledKeywordRule.keyword}」のルールを再開`,
          desc: '現在オフ',
          kind: 'ghost',
          onClick: onResumeKeyword
            ? () => onResumeKeyword(coveringDisabledKeywordRule.id)
            : undefined,
        };
      }
      // 単発予約済みなら追加の自動予約 CTA は隠す (取消が主役)。
      if (reserved) return null;
      return {
        title: '自動予約ルール',
        desc: '同じ番組を今後も自動録画',
        kind: 'ghost',
        onClick: () => onCreateRule(effectiveKeyword, program, [program.ch]),
      };
    }
    return null;
  })();

  // Slot 1 is suppressed when the series-rule path is the only meaningful
  // action: a single-booking cancel is meaningless once a series rule
  // covers the airing (the rule will just re-expand a fresh recording),
  // so the user is really managing the series. Recording-in-progress
  // airings keep slot1 because that's where the stop button lives.
  const slot1Hidden =
    ((coveredBySeriesRule || !!coveringKeywordRule) && !isRecordingNow) ||
    (isPast && !isRecordingNow);
  // While a recording is in progress, the only sensible slot1 is "停止";
  // nothing belongs in slot2 on top of that. Past airings: hide series-add
  // / cancel etc. — there's nothing to act on for an ended broadcast.
  const slot2Hidden = isRecordingNow || isPast;

  // Slot 2 gets a split chevron so the user can preview which airings
  // the underlying rule would catch. The preview is offered for every
  // actionable slot 2 variant — series-add (about to commit), already-
  // covered (verify what's still scheduled), disabled-rule (verify
  // before re-enabling), and the keyword-rule path for non-TVDB shows
  // (fallback substring match). The "他チャンネルで登録済み" variant
  // is excluded because its action is intentionally inert. Movies have
  // no recurrence so they also opt out.
  const slot2Action:
    | 'series-add' | 'series-resume' | 'series-covered'
    | 'keyword' | 'keyword-covered' | 'keyword-resume'
    | null =
    !slot2 || slot2Hidden || isMovie
      ? null
      : tvdb && tvdb.type === 'series' && coveredBySeriesRule
        ? 'series-covered'
        : tvdb && tvdb.type === 'series' && seriesRuleDisabled
          ? 'series-resume'
          : tvdb && tvdb.type === 'series' && !seriesRuledOnOtherChannel && !reserved
            ? 'series-add'
            : !tvdb && coveringKeywordRule
              ? 'keyword-covered'
              : !tvdb && coveringDisabledKeywordRule
                ? 'keyword-resume'
                : !tvdb && !reserved
                  ? 'keyword'
                  : null;

  // Episodes feeding the preview popover. Series paths reuse the
  // tvdb-keyed program list (already deduped, full schedule horizon).
  // Keyword path falls back to a substring search against the loaded
  // schedule — same heuristic the bulk rule expander uses.
  const previewEps = (() => {
    if (slot2Action === 'series-add' || slot2Action === 'series-covered' || slot2Action === 'series-resume') {
      return seriesEps;
    }
    if (slot2Action === 'keyword') {
      // サーバ側で 14 日窓を見て filter 済みの結果を優先。届く前は
      // フロントのロード済み schedule から仮で出しておく (深夜に開いた
      // 直後など、まだ ruleKeyword 未着の瞬間にプレビューが空にならない
      // ようにするためのフォールバック)。
      if (ruleMatches.length > 0) return ruleMatches;
      if (!effectiveKeyword) return [];
      return programs.filter((p) => p.title.includes(effectiveKeyword));
    }
    if (slot2Action === 'keyword-covered' && coveringKeywordRule) {
      // サーバ /rules/:id/matches の結果を優先 (14日窓 + rulePredicate ベース
      // で正確)。届く前はローカル schedule の文字列マッチで仮表示する。
      if (coveringRuleMatches.length > 0) return coveringRuleMatches;
      const kw = coveringKeywordRule.keyword;
      if (!kw) return [];
      return programs.filter((p) => p.title.includes(kw));
    }
    if (slot2Action === 'keyword-resume' && coveringDisabledKeywordRule) {
      // disabled ルールの「再開後に予約される番組」プレビュー。サーバ
      // /rules/:id/matches は rulePredicate を通すが、predicate は
      // enabled=false を弾くので呼ぶ意味がない。ここはローカル schedule の
      // substring + チャンネル制限で簡易プレビューする (シリーズの
      // series-resume が seriesEps を流すのと同じ温度感)。
      const kw = coveringDisabledKeywordRule.keyword;
      if (!kw) return [];
      const allowed = coveringDisabledKeywordRule.channels;
      return programs.filter((p) => {
        if (!p.title.includes(kw)) return false;
        if (allowed.length === 0) return true;
        return allowed.some((c) => channelKey(c) === channelKey(p.ch));
      });
    }
    return [];
  })();

  const previewLabel =
    slot2Action === 'series-covered' || slot2Action === 'keyword-covered'
      ? '今後録画される番組'
      : slot2Action === 'series-resume' || slot2Action === 'keyword-resume'
        ? '再開後に予約される番組'
        : '予約される番組';

  return (
    <div className="gp-actions">
      {!slot1Hidden && <ActionCard {...slot1} />}
      {slot2 && !slot2Hidden && (
        slot2Action != null
          ? (
            <PreviewSplitCard
              spec={slot2}
              episodes={previewEps}
              channels={channels}
              channelId={program.ch}
              previewLabel={previewLabel}
              currentProgram={program}
            />
          )
          : <ActionCard {...slot2} />
      )}
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

interface PreviewSplitCardProps {
  spec: ActionCardSpec;
  episodes: Program[];
  channels: Channel[];
  channelId: string;
  /** Heading rendered above the preview list. Lets the popover label
   *  itself contextually — "予約される番組" when about to commit,
   *  "今後録画される番組" when the rule already exists, etc. */
  previewLabel: string;
  /** The currently-viewed airing. Used to flag the matching row in the
   *  preview list with a "この番組" pill so the user can pick out which
   *  entry corresponds to the modal they have open. */
  currentProgram: Program;
}

// Split-button variant of ActionCard: main button commits the
// "シリーズを追加" action; the trailing ▼ pops a preview list of the
// airings on `channelId` that the new rule would actually reserve.
// The popover is informational only — clicking an entry does nothing
// (preview ≠ navigation) so the user's mental model stays simple:
// see what's coming, then commit.
function PreviewSplitCard({ spec, episodes, channels, channelId, previewLabel, currentProgram }: PreviewSplitCardProps) {
  const { title, desc, kind, onClick } = spec;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Match by the numeric service id (the part after the source
  // prefix), not the raw channel id. The DB carries parallel channels
  // for the same broadcaster — e.g. svc-3272202064 (Mirakurun) and
  // m3u-3272202064 (M3U) — and a given airing may only be present on
  // one source's EPG horizon. Matching strictly on `p.ch === channelId`
  // hides episodes that exist for the same MBS but came in via the
  // other source. Stripping the prefix unifies them in the preview.
  //
  // Otherwise mirrors rulePredicate (ruleExpander.ts): future airings
  // only. skipReruns / ngKeywords are not replicated — the preview is
  // a best estimate, not a hard guarantee.
  const targetKey = useMemo(() => channelKey(channelId), [channelId]);
  const upcoming = useMemo(() => {
    const now = Date.now();
    const filtered = episodes
      .filter((p) => channelKey(p.ch) === targetKey)
      .filter((p) => {
        const end = p.endAt ? Date.parse(p.endAt) : NaN;
        return !Number.isFinite(end) || end >= now;
      })
      .sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
    // Same broadcast often appears twice (svc- and m3u- both index it).
    // Collapse on (service-id, start instant) so each airing is one row.
    // Date.parse normalizes ISO offsets so `+09:00` and the equivalent `Z`
    // form merge into the same instant.
    const seen = new Set<string>();
    const out: Program[] = [];
    for (const p of filtered) {
      const t = p.startAt ? Date.parse(p.startAt) : NaN;
      const key = `${channelKey(p.ch)}-${Number.isFinite(t) ? t : (p.startAt ?? p.start)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }, [episodes, targetKey]);

  // Outside-click closes the popover. Pointerdown rather than click
  // so the popover dismisses before the click target fires (avoids
  // the chevron toggling back to open via the document handler).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const ch = getChannel(channels, channelId);
  const MAX = 12;
  const shown = upcoming.slice(0, MAX);
  const overflow = upcoming.length - shown.length;
  // Identity key for the row matching the currently-viewed airing —
  // matches the dedup key used in the upcoming/related lists so a
  // svc-/m3u- twin of "this airing" still flags as self.
  const selfKey = `${channelKey(currentProgram.ch)}-${
    currentProgram.startAt ? Date.parse(currentProgram.startAt) : currentProgram.start
  }`;

  return (
    <div className="gp-mode-split" ref={ref}>
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={`gp-mode-card ${kind} gp-mode-split-main`}
      >
        <span className="gp-mode-title">{title}</span>
        <span className="gp-mode-desc">{desc}</span>
      </button>
      <button
        type="button"
        className={`gp-mode-split-chev ${kind}${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={`${previewLabel}を表示`}
        aria-expanded={open}
        title={`${previewLabel}を表示`}
      >
        <Icon name="chevD" size={14} />
      </button>
      {open && (
        <div className="gp-series-preview" role="dialog" aria-label={previewLabel}>
          <div className="gp-series-preview-head">
            <span>{previewLabel}</span>
            <span className="gp-series-preview-ch">{ch?.name ?? channelId}</span>
          </div>
          {shown.length === 0 ? (
            <div className="gp-series-preview-empty">
              このチャンネルでの今後の放送予定は見つかりません
            </div>
          ) : (
            <ul className="gp-series-preview-list">
              {shown.map((p) => {
                const se =
                  p.tvdbSeason != null && p.tvdbEpisode != null
                    ? `S${p.tvdbSeason}E${p.tvdbEpisode}`
                    : null;
                const rowKey = `${channelKey(p.ch)}-${
                  p.startAt ? Date.parse(p.startAt) : p.start
                }`;
                const isSelf = rowKey === selfKey;
                return (
                  <li
                    key={progId(p)}
                    className={`gp-series-preview-row${isSelf ? ' is-self' : ''}`}
                  >
                    <span className="gp-series-preview-when">
                      {p.startAt ? jpAirDate(p.startAt).slice(5, 14) : p.start}
                    </span>
                    <span className="gp-series-preview-title">{p.title}</span>
                    {isSelf && <span className="gp-series-preview-self">この番組</span>}
                    {se && <span className="gp-series-preview-se">{se}</span>}
                  </li>
                );
              })}
              {overflow > 0 && (
                <li className="gp-series-preview-more">他 {overflow} 件</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
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

// Scan the broadcaster-supplied extended descriptor for http(s) URLs and
// pair each one with a friendly label. Labels prefer (a) the line
// immediately preceding the URL ("★番組HP\nhttp://..." is the common
// broadcaster pattern), then (b) a hand-curated brand name for known
// social hosts, then (c) the bare host. Duplicates are collapsed by URL.
const URL_RE = /https?:\/\/[^\s<>"'）)】\]]+/g;
const HOST_LABELS: Record<string, string> = {
  'twitter.com': 'X',
  'x.com': 'X',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'instagram.com': 'Instagram',
  'tiktok.com': 'TikTok',
  'facebook.com': 'Facebook',
  'line.me': 'LINE',
};

interface ExtractedLink { url: string; label: string; host: string }

function extractLinks(ext: Record<string, string> | null): ExtractedLink[] {
  if (!ext) return [];
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  for (const value of Object.values(ext)) {
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(value)) !== null) {
      let url = m[0];
      while (/[.,。、!?！？:;]$/.test(url)) url = url.slice(0, -1);
      if (seen.has(url)) continue;
      seen.add(url);

      let label = url;
      let host = '';
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
        const known = Object.entries(HOST_LABELS).find(([h]) => host === h || host.endsWith('.' + h));
        label = known ? known[1] : host;
      } catch {
        // keep defaults
      }

      const before = value.slice(0, m.index);
      const lastLine = before.split(/\r?\n/).pop()?.replace(/^[★☆●・※\s]+/, '').trim();
      if (lastLine && lastLine.length > 0 && lastLine.length <= 14) {
        label = lastLine;
      }

      out.push({ url, label, host });
    }
  }
  return out;
}

// Compact rounded-rect "external link" affordance — favicon + label, with
// subtle border + hover lift. Pulls the favicon via Google's s2 service so
// the chip carries genuine brand recognition (X glyph, YouTube play, TBS
// logo) rather than a generic icon. Falls back to a coloured monogram if
// the image can't load.
function LinkChip({ link }: { link: ExtractedLink }) {
  const [failed, setFailed] = useState(false);
  const faviconSrc = link.host
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(link.host)}&sz=64`
    : '';
  const monogram = (link.label.match(/[A-Za-z0-9一-龯ぁ-んァ-ヶ]/)?.[0] ?? '?').toUpperCase();
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={link.url}
      className="gp-link-chip"
    >
      <span className="gp-link-mark" aria-hidden="true">
        {!failed && faviconSrc ? (
          <img
            src={faviconSrc}
            alt=""
            width={14}
            height={14}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="gp-link-monogram">{monogram}</span>
        )}
      </span>
      <span className="gp-link-label">{link.label}</span>
    </a>
  );
}

