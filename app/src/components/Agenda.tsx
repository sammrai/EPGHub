// Agenda / list view + Rules page
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import { PageHead } from './Pages';
import { toMin, durLabel, MOCK_NOW_MIN, progId, getChannel, seriesCounts } from '../lib/epg';
import type { Channel, Program, Recording, Rule, TvdbSeries } from '../data/types';

// Partial patch shape passed to onSave. Kept loose here because the API
// accepts Partial<Rule> and TS unifies to string-ish at the call site.
export type RulePatch = {
  name?: string;
  keyword?: string;
  channels?: string[];
  priority?: 'high' | 'medium' | 'low';
  quality?: string;
  skipReruns?: boolean;
  enabled?: boolean;
};

// ============ AGENDA VIEW ============
export interface AgendaViewProps {
  programs: Program[];
  channels: Channel[];
  onSelect: (p: Program) => void;
  selectedId: string | null;
  reservedIds: Set<string>;
}

export function AgendaView({ programs, channels, onSelect, selectedId, reservedIds }: AgendaViewProps) {
  // Group by absolute hour (epoch-hour) so programs at the same HH:MM on
  // different broadcast days land in distinct buckets. Fall back to
  // minutes-from-midnight (treated as a base-day offset) when startAt is
  // absent — in that case all base-day-only programs share one day's worth
  // of buckets, matching the legacy single-day behavior.
  type Bucket = {
    /** Sort key: epoch-hour (ms / 3_600_000) when ISO present, else HH-only. */
    sortKey: number;
    /** Hour-of-day 0..23 for label rendering. */
    hour: number;
    /** Start-of-hour Date when ISO was available, else null. */
    date: Date | null;
    list: Program[];
  };
  const byKey: Record<string, Bucket> = {};
  programs.forEach(p => {
    let sortKey: number;
    let hour: number;
    let date: Date | null = null;
    if (p.startAt) {
      const t = Date.parse(p.startAt);
      if (!Number.isNaN(t)) {
        const hourMs = 3_600_000;
        const epochHour = Math.floor(t / hourMs);
        sortKey = epochHour;
        date = new Date(epochHour * hourMs);
        hour = date.getHours();
      } else {
        const h = Math.floor(toMin(p.start) / 60);
        sortKey = h;
        hour = h % 24;
      }
    } else {
      const h = Math.floor(toMin(p.start) / 60);
      sortKey = h;
      hour = h % 24;
    }
    const key = String(sortKey);
    const bucket = byKey[key] || (byKey[key] = { sortKey, hour, date, list: [] });
    bucket.list.push(p);
  });
  const buckets = Object.values(byKey).sort((a, b) => a.sortKey - b.sortKey);
  // Current epoch-hour (JST or local — Date.getHours above is local, but
  // sortKey is epoch-hour so a local-vs-UTC offset is absorbed consistently).
  const nowHourKey = Math.floor(Date.now() / 3_600_000);
  const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const dayKeyOf = (d: Date | null): string =>
    d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : 'base';
  // Per-bucket date prefix. Only emitted on the first bucket of each new
  // day (never on the overall first bucket — the date pill above already
  // shows that day). Eliminates the redundant "4/21 (火)" that used to
  // appear on every hour within the same day.
  const datePrefixes = buckets.map((b, i) => {
    if (i === 0 || !b.date) return '';
    if (dayKeyOf(b.date) === dayKeyOf(buckets[i - 1].date)) return '';
    return `${b.date.getMonth() + 1}/${b.date.getDate()} (${WEEKDAY_JA[b.date.getDay()]}) `;
  });
  const nowMs = Date.now();

  const programSort = (a: Program, b: Program): number => {
    const ta = a.startAt ? Date.parse(a.startAt) : NaN;
    const tb = b.startAt ? Date.parse(b.startAt) : NaN;
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    return toMin(a.start) - toMin(b.start);
  };

  // Auto-scroll the first time buckets arrive: jump to the hour containing
  // (or closest after) "now" so the user lands near live programming
  // instead of at the top of yesterday's slate.
  const containerRef = useRef<HTMLDivElement>(null);
  const didScrollRef = useRef(false);
  useEffect(() => {
    if (didScrollRef.current) return;
    if (buckets.length === 0 || !containerRef.current) return;
    const nowHour = Math.floor(Date.now() / 3_600_000);
    const keys = buckets.map((b) => b.sortKey);
    // Prefer the first bucket whose hour is now-or-later; fall back to the
    // last bucket when everything is in the past.
    const targetKey = keys.find((k) => k >= nowHour) ?? keys[keys.length - 1];
    const el = containerRef.current.querySelector<HTMLElement>(
      `[data-bucket-key="${targetKey}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: 'start' });
      didScrollRef.current = true;
    }
  }, [buckets.length]);

  return (
    <div className="agenda-view" ref={containerRef}>
      {buckets.map((bucket, idx) => {
        const { sortKey, hour, list: rawList } = bucket;
        const list = [...rawList].sort(programSort);
        const hourLabel = String(hour).padStart(2, '0');
        const datePrefix = datePrefixes[idx];
        return (
          <div
            key={sortKey}
            className={`agenda-hour${sortKey === nowHourKey ? ' is-now' : ''}`}
            data-bucket-key={sortKey}
          >
            <div className="agenda-hour-label">
              {datePrefix}{hourLabel}<span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}>:00</span>
              {sortKey === nowHourKey && <span className="agenda-now-tag">NOW</span>}
              <span className="agenda-hour-sub">{list.length}本 · {hour < 12 ? '午前' : hour < 18 ? '午後' : '夜間'}</span>
            </div>
            <div className="agenda-list">
              {list.map((p, i) => {
                const ch = channels.find(c => c.id === p.ch);
                const isRes = reservedIds.has(progId(p));
                const isRec = p.recording;
                const endMs = p.endAt ? Date.parse(p.endAt) : NaN;
                const isPast = !Number.isNaN(endMs)
                  ? endMs < nowMs
                  : toMin(p.end) < MOCK_NOW_MIN;
                return (
                  <div
                    key={i}
                    className={[
                      'agenda-item',
                      isRes && !isRec && 'reserved',
                      isRec && 'recording',
                      isPast && 'past',
                      selectedId === progId(p) && 'selected',
                    ].filter(Boolean).join(' ')}
                    onClick={() => onSelect(p)}
                  >
                    <div className="agenda-time">
                      <strong>{p.start}</strong><br />
                      <span>{p.end}</span>
                    </div>
                    <div className="agenda-ch">
                      <span className="agenda-ch-num">{ch?.number}</span>
                      <span>{ch?.name}</span>
                    </div>
                    <div className="agenda-title">
                      <div className="agenda-title-main">
                        {p.title}
                      </div>
                      <div className="agenda-title-sub">
                        <span className="g-dot" style={{ background: p.genre.dot }} />
                        <span>{p.genre.label}</span>
                        <span>·</span>
                        <span>{durLabel(p)}</span>
                        {p.ep && <><span>·</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{p.ep}</span></>}
                        {p.hd && <><span>·</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>HD</span></>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {isRec && <span className="agenda-badge rec">● REC</span>}
                      {isRes && !isRec && <span className="agenda-badge resv">予約</span>}
                      <div className="agenda-actions">
                        <button className="btn btn-sm ghost">
                          <Icon name="info" size={11} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============ Helpers (local — StatPill only; PageHead now comes from ./Pages) ============

type StatTone = 'ok' | 'accent' | 'rec';

interface StatPillProps {
  label: string;
  value: number | string;
  tone?: StatTone;
}

function StatPill({ label, value, tone }: StatPillProps) {
  const toneColor =
    tone === 'accent' ? 'var(--accent)' :
    tone === 'ok'     ? 'var(--ok)' :
    tone === 'rec'    ? 'var(--rec)' :
                        'var(--fg)';
  return (
    <div style={{ padding: '5px 12px', background: 'var(--bg-muted)', border: '1px solid var(--border)', borderRadius: 999, fontSize: 11.5, color: 'var(--fg-muted)' }}>
      {label} <strong style={{ color: toneColor, marginLeft: 4, fontFamily: 'var(--font-mono)' }}>{value}</strong>
    </div>
  );
}

// ============ RULES PAGE ============
export interface RulesPageProps {
  rules: Rule[];
  channels: Channel[];
  /** Ready recordings only — used to cross-check rule match counts and
   *  surface per-series recorded-episode totals. */
  recordings: Recording[];
  toggleRule: (id: number) => void;
  onCreate: () => void;
  updateRule: (id: number, patch: RulePatch) => void;
  deleteRule: (id: number) => void;
}

type RuleFilter = 'all' | 'rule' | 'series';

// Compute next auto-expand wall-clock time in JST, given the server-side cron
// '*/10 * * * *'. Returns the HH:MM label plus remaining minutes until that
// firing. Pattern mirrors other JST helpers in the codebase.
function computeNextExpand(): { hhmm: string; remain: number } {
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const minJst = nowJst.getUTCMinutes();
  const addMin = 10 - (minJst % 10);
  const target = new Date(nowJst.getTime() + addMin * 60 * 1000);
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  return { hhmm: `${hh}:${mm}`, remain: addMin };
}

export function RulesPage({ rules, channels, recordings, toggleRule, onCreate, updateRule, deleteRule }: RulesPageProps) {
  const [filter, setFilter] = useState<RuleFilter>('all');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [nextExpand, setNextExpand] = useState(() => computeNextExpand());
  useEffect(() => {
    const t = setInterval(() => setNextExpand(computeNextExpand()), 30_000);
    return () => clearInterval(t);
  }, []);
  const editingRule = editingId != null ? rules.find(r => r.id === editingId) ?? null : null;
  const filtered = rules.filter(r => {
    if (filter === 'all') return true;
    if (filter === 'series') return r.kind === 'series';
    return r.kind !== 'series';
  });
  // "次回予定あり" = enabled rules that the scheduler has resolved to an
  // upcoming program. We can't filter to "today" here because the Rule
  // adapter collapses nextMatch.at to HH:MM and drops the date — see
  // TODO(api) at the bottom of this file.
  const scheduledCount = rules.reduce(
    (s, r) => s + (r.enabled && r.nextMatch ? 1 : 0),
    0
  );
  // Cumulative recordings across all rules (authoritative from API).
  const totalRecorded = rules.reduce((s, r) => s + r.matches, 0);
  return (
    <div className="page">
      <PageHead title="ルール録画" />

      <div style={{ display: 'flex', gap: 8, marginBottom: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatPill label="合計" value={rules.length} />
        <StatPill label="有効"   value={rules.filter(r => r.enabled).length} tone="ok" />
        <StatPill label="次回予定あり" value={scheduledCount} tone="accent" />
        <StatPill label="累計録画" value={totalRecorded} />
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
          次回自動展開: {nextExpand.hhmm} (残り{nextExpand.remain}分)
        </div>
        <div className="seg-sm">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全て</button>
          <button className={filter === 'rule' ? 'active' : ''} onClick={() => setFilter('rule')}>ルール</button>
          <button className={filter === 'series' ? 'active' : ''} onClick={() => setFilter('series')}>シリーズ</button>
        </div>
      </div>

      {filtered.map(r => r.kind === 'series'
        ? <SeriesRuleCard key={r.id} rule={r} recordings={recordings} onToggle={() => toggleRule(r.id)} onEdit={() => setEditingId(r.id)} />
        : <RuleCard key={r.id} rule={r} channels={channels} recordings={recordings} onToggle={() => toggleRule(r.id)} onEdit={() => setEditingId(r.id)} />
      )}
      {filtered.length === 0 && (
        <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
          該当するルールはありません。
        </div>
      )}

      {editingRule && (
        <RuleEditModal
          rule={editingRule}
          channels={channels}
          onClose={() => setEditingId(null)}
          onSave={(id, patch) => {
            updateRule(id, patch);
            setEditingId(null);
          }}
          onDelete={(id) => {
            deleteRule(id);
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
}

export interface RuleCardProps {
  rule: Rule;
  channels: Channel[];
  recordings: Recording[];
  onToggle: () => void;
  onEdit?: () => void;
}

export function RuleCard({ rule, channels, recordings, onToggle, onEdit }: RuleCardProps) {
  const ruleChannels = rule.channels
    .map((id) => getChannel(channels, id))
    .filter((c): c is Channel => !!c);
  // Cross-check rule.matches (from the scheduler) against actual recordings
  // that landed under this rule's name, and show the higher of the two so
  // freshly fired matches that haven't been counted yet still show up.
  const ruleRecordedCount = recordings.filter((r) => r.ruleMatched === rule.name).length;
  const matchCount = Math.max(rule.matches, ruleRecordedCount);
  return (
    <div className={`rule-card ${!rule.enabled ? 'disabled' : ''}`}>
      <div className="rule-card-top">
        <div
          className={`toggle ${rule.enabled ? 'on' : ''}`}
          onClick={(e: MouseEvent<HTMLDivElement>) => { e.stopPropagation(); onToggle(); }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="kind-tag rule">ルール</span>
            <div className="rule-name">{rule.name}</div>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>
            キーワード「{rule.keyword}」
          </div>
        </div>
        <div
          style={{
            padding: '3px 8px',
            background: rule.priority === 'high' ? 'oklch(0.95 0.05 25)' : 'var(--bg-muted)',
            color: rule.priority === 'high' ? 'oklch(0.5 0.15 25)' : 'var(--fg-muted)',
            borderRadius: 4, fontSize: 10.5, fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em',
          }}
        >
          {rule.priority === 'high' ? '優先度: 高' : rule.priority === 'medium' ? '優先度: 中' : '優先度: 低'}
        </div>
        {onEdit && (
          <button
            className="btn btn-sm ghost"
            title="編集"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
          >
            <Icon name="pencil" size={11} />
          </button>
        )}
      </div>
      <div className="rule-meta-row">
        <span className="kv">
          <Icon name="tv" size={11} />{' '}
          {ruleChannels.length === 0
            ? '全チャンネル'
            : ruleChannels.map((c) => c.name).join(', ')}
        </span>
        <span className="kv">品質 <strong>{rule.quality}</strong></span>
        <span className="kv">録画数 <strong>{matchCount}</strong></span>
        <span className="kv">再放送 <strong>{rule.skipReruns ? 'スキップ' : '録画'}</strong></span>
        {rule.nextMatch && rule.enabled && (
          <span className="kv" style={{ marginLeft: 'auto', color: 'var(--accent)', fontFamily: 'var(--font-jp)' }}>
            <Icon name="clock" size={11} /> 次回 {rule.nextMatch.at} · {rule.nextMatch.title.length > 20 ? rule.nextMatch.title.slice(0, 20) + '…' : rule.nextMatch.title}
          </span>
        )}
      </div>
    </div>
  );
}

// Series rule card — TVDB-linked, no trigger (keyword/channel) info shown.
export interface SeriesRuleCardProps {
  rule: Rule;
  recordings: Recording[];
  onToggle: () => void;
  onEdit?: () => void;
}

export function SeriesRuleCard({ rule, recordings, onToggle, onEdit }: SeriesRuleCardProps) {
  // Series rules are expected to have a TvdbSeries tvdb entry.
  const tvdb = rule.tvdb as TvdbSeries | undefined;
  if (!tvdb) return null;
  const seriesRecorded = recordings.filter(r => r.tvdbId === tvdb.id);
  const counts = seriesCounts(tvdb, seriesRecorded);
  const posterBg = `linear-gradient(145deg, oklch(0.55 0.13 ${tvdb.id % 360}), oklch(0.38 0.11 ${tvdb.id * 2 % 360}))`;
  const recordedCount = seriesRecorded.length;
  const metaParts: string[] = ['TVDBに紐付け'];
  if (counts.partial) {
    metaParts.push('シーズン情報未取得');
  } else {
    metaParts.push(`全${counts.totalSeasons}シーズン`);
    if (counts.currentSeason > 0) metaParts.push(`放送中シーズン${counts.currentSeason}`);
  }
  return (
    <div className={`rule-card series-rule-card ${!rule.enabled ? 'disabled' : ''}`}>
      <div className="rule-card-top">
        <div
          className={`toggle ${rule.enabled ? 'on' : ''}`}
          onClick={(e: MouseEvent<HTMLDivElement>) => { e.stopPropagation(); onToggle(); }}
        />
        <div className="series-rule-poster" style={{ background: posterBg }}>
          {tvdb.titleEn.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="kind-tag tvdb">シリーズ</span>
            <div className="rule-name">{tvdb.title}</div>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{tvdb.titleEn}</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 3 }}>
            {metaParts.join(' · ')}
          </div>
        </div>
        <div
          style={{
            padding: '3px 8px',
            background: rule.priority === 'high' ? 'oklch(0.95 0.05 25)' : 'var(--bg-muted)',
            color: rule.priority === 'high' ? 'oklch(0.5 0.15 25)' : 'var(--fg-muted)',
            borderRadius: 4, fontSize: 10.5, fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em',
          }}
        >
          {rule.priority === 'high' ? '優先度: 高' : rule.priority === 'medium' ? '優先度: 中' : '優先度: 低'}
        </div>
        {onEdit && (
          <button
            className="btn btn-sm ghost"
            title="編集"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
          >
            <Icon name="pencil" size={11} />
          </button>
        )}
      </div>
      <div className="rule-meta-row">
        <span className="kv">品質 <strong>{rule.quality}</strong></span>
        <span className="kv">録画済 <strong>{recordedCount}話</strong></span>
        <span className="kv">再放送 <strong>{rule.skipReruns ? 'スキップ' : '録画'}</strong></span>
        {rule.nextMatch && rule.enabled && (
          <span className="kv" style={{ marginLeft: 'auto', color: 'var(--accent)', fontFamily: 'var(--font-jp)' }}>
            <Icon name="clock" size={11} /> 次回 {rule.nextMatch.at} · {rule.nextMatch.title.length > 20 ? rule.nextMatch.title.slice(0, 20) + '…' : rule.nextMatch.title}
          </span>
        )}
      </div>
    </div>
  );
}

// ============ RULE EDIT MODAL ============
export interface RuleEditModalProps {
  rule: Rule;
  channels: Channel[];
  onClose: () => void;
  onSave: (id: number, patch: RulePatch) => void;
  onDelete: (id: number) => void;
}

export function RuleEditModal({ rule, channels, onClose, onSave, onDelete }: RuleEditModalProps) {
  const isSeries = rule.kind === 'series';
  const [name, setName] = useState(rule.name);
  const [keyword, setKeyword] = useState(rule.keyword);
  const [selectedChannels, setSelectedChannels] = useState<string[]>(rule.channels);
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>(rule.priority);
  const [quality, setQuality] = useState<string>(rule.quality);
  const [skipReruns, setSkipReruns] = useState<boolean>(rule.skipReruns);
  const [enabled, setEnabled] = useState<boolean>(rule.enabled);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleChannel = (id: string) => {
    setSelectedChannels((cur) => cur.includes(id) ? cur.filter(c => c !== id) : [...cur, id]);
  };

  // Build a minimal patch of changed fields only. Don't send keyword for
  // series rules — those are TVDB-driven and keyword is not user-editable.
  const buildPatch = (): RulePatch => {
    const patch: RulePatch = {};
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== rule.name) patch.name = trimmedName;
    if (!isSeries) {
      const trimmedKw = keyword.trim();
      if (trimmedKw && trimmedKw !== rule.keyword) patch.keyword = trimmedKw;
    }
    // Channels: compare as sorted sets.
    const a = [...rule.channels].sort();
    const b = [...selectedChannels].sort();
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) patch.channels = selectedChannels;
    if (priority !== rule.priority) patch.priority = priority;
    if (quality !== rule.quality) patch.quality = quality;
    if (skipReruns !== rule.skipReruns) patch.skipReruns = skipReruns;
    if (enabled !== rule.enabled) patch.enabled = enabled;
    return patch;
  };

  // Required-field validation. For non-series rules, keyword cannot be
  // empty; name is always required.
  const canSave =
    name.trim().length > 0 && (isSeries || keyword.trim().length > 0);

  const handleSave = () => {
    if (!canSave) return;
    onSave(rule.id, buildPatch());
  };

  const handleDelete = () => {
    const label = rule.tvdb?.title ?? rule.name;
    if (!window.confirm(`ルール「${label}」を削除します。よろしいですか？`)) return;
    onDelete(rule.id);
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`kind-tag ${isSeries ? 'tvdb' : 'rule'}`}>{isSeries ? 'シリーズ' : 'ルール'}</span>
            <span className="modal-title">ルール編集</span>
          </div>
          {isSeries && rule.tvdb && (
            <div className="modal-subtitle-row">
              <span style={{ fontFamily: 'var(--font-mono)' }}>{rule.tvdb.titleEn}</span>
            </div>
          )}
        </div>
        <div className="modal-body">
          {/* Name */}
          <label className="opt-label" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <span className="opt-label-text">ルール名</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ルール名"
            />
          </label>

          {/* Keyword (disabled for series) */}
          <label className="opt-label" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <span className="opt-label-text">キーワード{isSeries && <span style={{ marginLeft: 6, fontSize: 10.5 }}>(シリーズルールでは変更不可)</span>}</span>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              disabled={isSeries}
              placeholder="タイトル含有文字列"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </label>

          {/* Channels */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="opt-label-text" style={{ fontSize: 12 }}>
              チャンネル
              <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--fg-subtle)' }}>
                {selectedChannels.length === 0 ? '(未選択 = 全チャンネル)' : `${selectedChannels.length}件`}
              </span>
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {channels.map((c) => {
                const on = selectedChannels.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => toggleChannel(c.id)}
                    className="btn btn-sm"
                    style={{
                      background: on ? 'var(--accent-soft)' : 'var(--bg-elev)',
                      borderColor: on ? 'var(--accent)' : 'var(--border)',
                      color: on ? 'var(--accent)' : 'var(--fg-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{c.number}</span>
                    <span style={{ marginLeft: 4 }}>{c.short || c.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Priority / quality / skipReruns / enabled */}
          <div className="opt-row">
            <label className="opt-label">
              <span className="opt-label-text">優先度</span>
              <div className="seg-sm">
                {(['high', 'medium', 'low'] as const).map(p => (
                  <button key={p} className={priority === p ? 'active' : ''} onClick={() => setPriority(p)}>
                    {p === 'high' ? '高' : p === 'medium' ? '中' : '低'}
                  </button>
                ))}
              </div>
            </label>
            <label className="opt-label">
              <span className="opt-label-text">品質</span>
              <div className="seg-sm">
                {(['1080i', '720p'] as const).map(q => (
                  <button key={q} className={quality === q ? 'active' : ''} onClick={() => setQuality(q)}>{q}</button>
                ))}
              </div>
            </label>
            <label className="opt-label">
              <span className="opt-label-text">再放送</span>
              <div className="seg-sm">
                <button className={skipReruns ? 'active' : ''} onClick={() => setSkipReruns(true)}>スキップ</button>
                <button className={!skipReruns ? 'active' : ''} onClick={() => setSkipReruns(false)}>録画</button>
              </div>
            </label>
            <label className="opt-label">
              <span className="opt-label-text">有効</span>
              <div
                className={`toggle ${enabled ? 'on' : ''}`}
                onClick={() => setEnabled((v) => !v)}
              />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn danger" onClick={handleDelete} title="ルールを削除">
            削除
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn accent" disabled={!canSave} onClick={handleSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// TODO(api): lib/adapters.ts#toRule collapses nextMatch.at from ISO-8601
// to a bare "HH:MM" string, so date-aware metrics (e.g. "本日一致",
// upcoming-week bucket) cannot be derived client-side. Preserve the ISO
// timestamp in Rule.nextMatch.at and format at render time to unlock that.
