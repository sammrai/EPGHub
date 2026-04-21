// Global command-palette style search overlay.
// GitHub の検索モーダル / Raycast / Linear の Cmd-K をベースにした、
// セクション分け & キーボード駆動の UI。サーバの GET /search を叩き、
// 番組 / シリーズ / チャンネル / ルール / 録画の 5 セクションを一覧する。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useSearch } from '../lib/hooks';
import { hhmm } from '../lib/adapters';
import { findFoldedIndex, kanaFold } from '../lib/textFold';
import type {
  ApiChannel,
  ApiProgram,
  ApiRecording,
  ApiRule,
  ApiTvdbEntry,
} from '../api/epghub';

export type SearchAction =
  | { kind: 'program'; program: ApiProgram }
  | { kind: 'series'; entry: ApiTvdbEntry }
  | { kind: 'channel'; channel: ApiChannel }
  | { kind: 'rule'; rule: ApiRule }
  | { kind: 'recording'; recording: ApiRecording };

export interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  onPick: (action: SearchAction) => void;
}

interface MatchContext {
  /** 'desc' | extended のキー名 (出演者/スタッフ等) | 'series' */
  field: string;
  /** 前後を切り詰めた本文。matched は snippet 内の相対オフセット + 長さ。 */
  snippet: string;
  matchStart: number;
  matchLength: number;
}

interface FlatItem {
  key: string;
  section: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  accent?: string;
  badges?: string[];
  context?: MatchContext;
  action: SearchAction;
}

// extended フィールドのキー名は ARIB の日本語 ("出演者" 等) と英語が混在するので
// 表示用に短縮マップを持つ。未知キーはそのまま流す。
const FIELD_LABEL: Record<string, string> = {
  desc: '概要',
  series: 'シリーズ',
};

function labelField(raw: string): string {
  return FIELD_LABEL[raw] ?? raw;
}

// タイトル外の文字列のうち、クエリがヒットする最初のフィールドから前後 30 字分を
// 切り出す。ヒットなし / タイトル自体が既にヒットしているなら null。
function buildMatchContext(p: ApiProgram, query: string): MatchContext | null {
  const q = query.trim();
  if (q.length === 0) return null;
  if (findFoldedIndex(p.title, q)) return null;

  const candidates: Array<[string, string]> = [];
  if (p.desc) candidates.push(['desc', p.desc]);
  if (p.extended) {
    for (const [k, v] of Object.entries(p.extended)) {
      if (v) candidates.push([k, v]);
    }
  }
  if (p.series) candidates.push(['series', p.series]);

  for (const [field, value] of candidates) {
    const hit = findFoldedIndex(value, q);
    if (!hit) continue;
    const CTX = 28;
    const start = Math.max(0, hit.start - CTX);
    const end = Math.min(value.length, hit.start + hit.length + CTX);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < value.length ? '…' : '';
    const snippet = prefix + value.slice(start, end) + suffix;
    return {
      field,
      snippet,
      matchStart: (hit.start - start) + prefix.length,
      matchLength: hit.length,
    };
  }
  return null;
}

const SECTION_META: Record<string, { label: string; icon: IconName }> = {
  programs:   { label: '番組',       icon: 'tv' },
  series:     { label: 'シリーズ',    icon: 'sparkle' },
  recordings: { label: '録画',       icon: 'rec' },
  rules:      { label: 'ルール',      icon: 'folder' },
  channels:   { label: 'チャンネル',  icon: 'tuner' },
};

const STATE_LABEL: Record<ApiRecording['state'], string> = {
  scheduled: '予約',
  recording: '録画中',
  encoding:  'エンコード',
  ready:     '視聴可能',
  failed:    '失敗',
  conflict:  '競合',
};

export function SearchPalette({ open, onClose, onPick }: SearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { data, loading } = useSearch(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // Focus after the paint so the input exists + animation has started.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const items = useMemo<FlatItem[]>(() => {
    if (!data) return [];
    const out: FlatItem[] = [];
    for (const p of data.programs) {
      const ctx = buildMatchContext(p, query);
      out.push({
        key: `p:${p.id}`,
        section: 'programs',
        icon: 'tv',
        title: p.title,
        subtitle: `${p.ch} · ${hhmm(p.startAt)}-${hhmm(p.endAt)}`,
        accent: p.genre?.dot,
        badges: [p.genre?.label ?? ''].filter(Boolean),
        context: ctx ?? undefined,
        action: { kind: 'program', program: p },
      });
    }
    for (const e of data.series) {
      const badges: string[] = [];
      if (e.type === 'series') badges.push(`S${e.totalSeasons} · ${e.totalEps}話`);
      else badges.push('映画');
      if (e.network) badges.push(e.network);
      out.push({
        key: `s:${e.id}`,
        section: 'series',
        icon: 'sparkle',
        title: e.title,
        subtitle: e.titleEn && e.titleEn !== e.title ? e.titleEn : `${e.year}`,
        badges,
        action: { kind: 'series', entry: e },
      });
    }
    for (const r of data.recordings) {
      out.push({
        key: `rec:${r.id}`,
        section: 'recordings',
        icon: 'rec',
        title: r.title,
        subtitle: `${r.ch} · ${hhmm(r.startAt)}`,
        badges: [STATE_LABEL[r.state]],
        action: { kind: 'recording', recording: r },
      });
    }
    for (const r of data.rules) {
      out.push({
        key: `rule:${r.id}`,
        section: 'rules',
        icon: 'folder',
        title: r.name,
        subtitle: `keyword: ${r.keyword}`,
        badges: [r.enabled ? '有効' : '停止', r.kind === 'series' ? 'シリーズ' : 'キーワード'],
        action: { kind: 'rule', rule: r },
      });
    }
    for (const c of data.channels) {
      out.push({
        key: `c:${c.id}`,
        section: 'channels',
        icon: 'tuner',
        title: c.name,
        subtitle: `${c.type} · ${c.number}`,
        accent: c.color,
        action: { kind: 'channel', channel: c },
      });
    }
    return out;
  }, [data]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  // Ensure the active row scrolls into view without jumping the whole modal.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // NOTE: すべての hook をこの useMemo までで呼び終えること。
  // 早期 return は必ずこの後。React は hook の呼び出し順で識別するので、
  // open の true/false 遷移で hook 数が変わると "Rendered more hooks than
  // during the previous render" でクラッシュする。
  const grouped = useMemo(() => {
    const by = new Map<string, FlatItem[]>();
    for (const it of items) {
      const bucket = by.get(it.section) ?? [];
      bucket.push(it);
      by.set(it.section, bucket);
    }
    return Array.from(by.entries());
  }, [items]);

  if (!open) return null;

  const commit = (idx: number) => {
    const it = items[idx];
    if (!it) return;
    onPick(it.action);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // IME の変換中 (ひらがな→漢字確定前) に押された Enter / 矢印キーは
    // 候補の選択・確定操作なので、パレットのコマンドとして解釈しない。
    // React は e.nativeEvent.isComposing を提供する。keyCode 229 は
    // Safari 等が isComposing を立てないケースのフォールバック。
    const composing =
      e.nativeEvent.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229;

    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (composing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(active);
    }
  };

  return (
    <div className="search-palette-backdrop" onClick={onClose}>
      <div
        className="search-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label="Global search"
      >
        <div className="search-palette-head">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="番組・シリーズ・局・ルール・録画を横断検索"
            spellCheck={false}
            autoComplete="off"
          />
          {loading && <span className="search-palette-loading" aria-hidden />}
          <kbd className="search-palette-kbd">Esc</kbd>
        </div>

        <div className="search-palette-body" ref={listRef}>
          {query.trim().length === 0 && <EmptyHints />}

          {query.trim().length > 0 && !loading && items.length === 0 && (
            <div className="search-palette-empty">
              <Icon name="search" size={20} />
              <div className="title">一致するものが見つかりません</div>
              <div className="hint">
                「{query.trim()}」を番組表・ライブラリ・ルール・TVDB から探しましたが、
                ヒットがありませんでした。タイトルの別表記、英題、漢字/かな違いも試してみてください。
              </div>
            </div>
          )}

          {grouped.map(([section, list]) => (
            <section key={section} className="search-palette-section">
              <header>
                <Icon name={SECTION_META[section]?.icon ?? 'search'} size={11} />
                <span>{SECTION_META[section]?.label ?? section}</span>
                <span className="count">{list.length}</span>
              </header>
              {list.map((it) => {
                const idx = items.findIndex((x) => x.key === it.key);
                const isActive = idx === active;
                return (
                  <button
                    key={it.key}
                    data-idx={idx}
                    className={`search-palette-row ${isActive ? 'active' : ''}`}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => commit(idx)}
                  >
                    <span
                      className="search-palette-row-icon"
                      style={it.accent ? ({ color: it.accent } as CSSProperties) : undefined}
                    >
                      <Icon name={it.icon} size={13} />
                    </span>
                    <span className="search-palette-row-main">
                      <span className="search-palette-row-title">
                        <Highlight text={it.title} query={query} />
                      </span>
                      {it.subtitle && (
                        <span className="search-palette-row-sub">
                          <Highlight text={it.subtitle} query={query} />
                        </span>
                      )}
                      {it.context && (
                        <span className="search-palette-row-context">
                          <span className="search-palette-row-context-field">
                            {labelField(it.context.field)}
                          </span>
                          <span className="search-palette-row-context-snippet">
                            {renderSnippet(it.context)}
                          </span>
                        </span>
                      )}
                    </span>
                    {it.badges && it.badges.length > 0 && (
                      <span className="search-palette-row-badges">
                        {it.badges.map((b, i) => (
                          <span key={i} className="search-palette-badge">
                            {b}
                          </span>
                        ))}
                      </span>
                    )}
                    {isActive && (
                      <span className="search-palette-row-hint">
                        <Icon name="arrow" size={10} />
                      </span>
                    )}
                  </button>
                );
              })}
            </section>
          ))}
        </div>

        <footer className="search-palette-foot">
          <span className="foot-item"><kbd>↑</kbd><kbd>↓</kbd>選択</span>
          <span className="foot-item"><kbd>↵</kbd>開く</span>
          <span className="foot-item"><kbd>Esc</kbd>閉じる</span>
          {data && (
            <span className="foot-item foot-total">{data.total} 件</span>
          )}
        </footer>
      </div>
    </div>
  );
}

function EmptyHints() {
  const tips: Array<{ icon: IconName; label: string; text: string }> = [
    { icon: 'tv',      label: '番組',       text: '「大河」で今日以降の回を含む全放送を横断。' },
    { icon: 'sparkle', label: 'シリーズ',    text: 'TVDB の和題・英題・slug に部分一致。' },
    { icon: 'folder',  label: 'ルール',      text: 'ルール名や keyword から既存ルールへ素早くジャンプ。' },
    { icon: 'rec',     label: '録画',       text: '録画中・録画済みのタイトルをそのまま探せます。' },
  ];
  return (
    <div className="search-palette-hints">
      <div className="search-palette-hints-head">ヒント</div>
      {tips.map((t) => (
        <div key={t.label} className="search-palette-hint-row">
          <span className="search-palette-row-icon"><Icon name={t.icon} size={12} /></span>
          <div>
            <div className="search-palette-hint-label">{t.label}</div>
            <div className="search-palette-hint-text">{t.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Case-insensitive + kana-folded substring highlight. サーバ側のマッチ規則と
// 揃え、"どらま" 入力でも "ドラマ" の出現を <mark> で囲む。fold は 1:1
// コードポイント置換なのでインデックスは元テキストにそのまま使える。
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (q.length === 0) return <>{text}</>;
  const folded = kanaFold(text).toLowerCase();
  const needle = kanaFold(q).toLowerCase();
  if (needle.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let from = 0;
  while (from < text.length) {
    const hit = folded.indexOf(needle, from);
    if (hit === -1) {
      out.push(text.slice(from));
      break;
    }
    if (hit > from) out.push(text.slice(from, hit));
    out.push(
      <mark key={`${hit}-${from}`} className="search-palette-mark">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    from = hit + needle.length;
  }
  return <>{out}</>;
}

// スニペットの matchStart/Length 位置に <mark> を差し込む専用レンダラ。
// Highlight と違い "折り畳み後のオフセットを既に持っている" 前提なので
// 文字列全走査なし。
function renderSnippet(ctx: MatchContext): ReactNode {
  const { snippet, matchStart, matchLength } = ctx;
  if (matchLength <= 0) return snippet;
  return (
    <>
      {snippet.slice(0, matchStart)}
      <mark className="search-palette-mark">
        {snippet.slice(matchStart, matchStart + matchLength)}
      </mark>
      {snippet.slice(matchStart + matchLength)}
    </>
  );
}
