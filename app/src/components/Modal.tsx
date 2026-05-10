// Auxiliary modals + helpers shared by GuidePanel:
//   - DebugDetailsModal: raw EPG / TVDB inspector
//   - RematchButton: re-runs TVDB matching for a single program
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import { jpAirDate } from '../lib/adapters';
import { api } from '../api/epghub';
import { tvdbHomepage } from '../lib/tvdbVisual';
import type { Program } from '../data/types';

interface DebugDetailsModalProps {
  program: Program;
  /** Recordings DB row id for this program, when a recording exists.
   *  Surfaced verbatim alongside program.id so support requests carry
   *  enough context to find the row in the DB. */
  recordingId?: string | null;
  /** Called after a successful "再マッチ" so the schedule re-fetches
   *  and the modal contents (and the underlying GuidePanel) reflect
   *  the new tvdbSeason / tvdbEpisode without a manual reload. */
  onRefresh?: () => void | Promise<void>;
  onClose: () => void;
}

// Copy `text` to the clipboard, falling back to a hidden textarea when
// the page isn't served over a secure context (clipboard API gated).
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to legacy path
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

// Minimal copy affordance — sits inline next to a value, looks like a
// faded glyph until hover, and flashes a check mark for ~1.2s after a
// successful copy. Stops propagation so the parent modal backdrop can't
// see the click and close itself.
function CopyIconButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="クリップボードにコピー"
      aria-label="クリップボードにコピー"
      onClick={async (e) => {
        e.stopPropagation();
        await writeClipboard(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        padding: 0,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: copied ? 'var(--accent)' : 'var(--fg-subtle)',
        opacity: copied ? 1 : 0.6,
        flexShrink: 0,
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
    </button>
  );
}

// Mono-font value paired with an inline copy button. `display` is what
// the user sees; `text` is the table-qualified payload that gets copied.
function IdValue({ text, display }: { text: string; display: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          wordBreak: 'break-all',
          whiteSpace: 'pre-wrap',
        }}
      >
        {display}
      </span>
      <CopyIconButton text={text} />
    </span>
  );
}

// "再マッチ" trigger inside the debug modal. Re-uses POST /programs/:id/tvdb
// (matchService.linkProgram), which re-fetches the TVDB episode list and
// runs findEpisodeForProgram for this program — picking up matcher logic
// improvements (e.g. the cumulative-N fallback) without waiting for the
// next EPG refresh, since `enrichUnmatched` only touches tvdbId-null rows.
//
// onRefresh is called after the server returns 200 so the parent (App)
// can re-fetch the schedule. The new program data flows back through
// the modal's props, updating both the debug rows AND the underlying
// GuidePanel (title row, bottom S/E chip) without a manual reload.
export function RematchButton({
  programId,
  onRefresh,
  variant = 'default',
}: {
  programId: string;
  onRefresh?: () => void | Promise<void>;
  // 'subtle' renders as a borderless inline glyph + label sized to sit
  // alongside the S/E subtitle without competing for attention. The
  // default variant keeps the bordered chip used by DebugDetailsModal.
  variant?: 'default' | 'subtle';
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'nomatch' | 'err'>('idle');
  const onClick = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (state === 'loading') return;
    setState('loading');
    try {
      const res = await api.programs.rematch(programId);
      if (onRefresh) await onRefresh();
      setState(res.matched ? 'ok' : 'nomatch');
      window.setTimeout(() => setState('idle'), res.matched ? 1500 : 2400);
    } catch {
      setState('err');
      window.setTimeout(() => setState('idle'), 2000);
    }
  };
  const label =
    state === 'loading' ? '再マッチ中…'
      : state === 'ok' ? '更新しました'
      : state === 'nomatch' ? '見つかりません'
      : state === 'err' ? '失敗'
      : '再マッチ';
  const color =
    state === 'ok' ? 'var(--accent)'
      : state === 'err' ? 'var(--rec, #c0392b)'
      : state === 'nomatch' ? 'var(--fg-muted)'
      : variant === 'subtle' ? 'var(--fg-subtle)'
      : 'var(--fg-muted)';
  const baseStyle: CSSProperties = variant === 'subtle'
    ? {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: 0,
        background: 'transparent',
        border: 'none',
        color,
        cursor: state === 'loading' ? 'progress' : 'pointer',
        fontSize: 10.5,
        fontWeight: 500,
        lineHeight: 1,
        opacity: state === 'idle' ? 0.7 : 1,
      }
    : {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        height: 22,
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 6,
        color,
        cursor: state === 'loading' ? 'progress' : 'pointer',
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1,
      };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'loading'}
      title="TVDB エピソード一覧を再取得し、この番組の S/E を解決し直す"
      style={baseStyle}
    >
      <Icon name={state === 'ok' ? 'check' : 'cycle'} size={variant === 'subtle' ? 10 : 11} />
      <span>{label}</span>
    </button>
  );
}

// Build the GitHub issue prefill URL for a "マッチが違う" report. The title
// + body carry exactly the fields the maintainer needs to reproduce the
// case in `findEpisodeForProgram.test.ts`: programs.id, raw EPG title,
// startAt (UTC ISO), channel id, and the current TVDB linkage. The user
// fills in their expected S/E (or "should not match") on GitHub. No
// auth/token/backend required — opens the user's browser to the
// pre-filled "New issue" form, they click Submit.
function reportMatchUrl(p: Program): string {
  const tvdbId = p.tvdb?.id ?? null;
  const tvdbTitle = p.tvdb?.title ?? null;
  const season = p.tvdbSeason ?? null;
  const episode = p.tvdbEpisode ?? null;
  const epName = p.tvdbEpisodeName ?? null;
  // Trim ".SSS" / ":00" off the ISO so the issue title stays readable.
  const startShort = p.startAt
    ? p.startAt.replace(/\.\d{3}Z$/, 'Z').replace(/:\d{2}Z$/, 'Z')
    : '';
  const titleLine = startShort
    ? `[match-report] ${p.title} — ${p.ch} (${startShort})`
    : `[match-report] ${p.title}`;
  const lines = [
    '### マッチ報告',
    '',
    '**Program**',
    `- programs.id: \`${p.id ?? '(unknown)'}\``,
    `- title: \`${p.title}\``,
    `- ch: \`${p.ch}\``,
    `- startAt: \`${p.startAt ?? '(unknown)'}\``,
  ];
  if (p.ep) lines.push(`- ep: \`${p.ep}\``);
  if (p.series) lines.push(`- series: \`${p.series}\``);
  lines.push(
    '',
    '**現在のマッチ**',
    `- tvdb_id: \`${tvdbId ?? 'null'}\`${tvdbTitle ? ` (${tvdbTitle})` : ''}`,
    `- season / episode: \`${season ?? '—'}\` / \`${episode ?? '—'}\``,
    `- episode_name: \`${epName ?? '—'}\``,
    '',
    '**期待される結果**',
    '',
    '> 正しいマッチ先がわかれば記載してください（任意）。例: `tvdb_id=425870, S2E5` / 「マッチしないのが正しい」',
    '',
    '',
    '**コメント**',
    '',
    '> 補足や参考情報があれば記載してください（任意）',
    '',
  );
  // ラベルは1つだけ:
  //   `fix-match`  EPG → TVDB マッチ違いの報告を一掴みするためのフラグ。
  //   現状の紐付け有無は本文の `tvdb_id` フィールドで判別できるので、
  //   ラベルは流入カテゴリの粒度にしない。
  const params = new URLSearchParams({
    title: titleLine,
    body: lines.join('\n'),
    labels: 'fix-match',
  });
  return `https://github.com/sammrai/EPGHub/issues/new?${params.toString()}`;
}

// "マッチが違う" 報告ボタン。GitHub の "New issue" 画面を新タブで prefill
// 状態で開く（トークン/バックエンド不要）。DebugDetailsModal フッターから
// だけ呼ばれる — 通常モーダルにはノイズになるため出さない設計。
function ReportMatchButton({ program }: { program: Program }) {
  return (
    <a
      href={reportMatchUrl(program)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="btn"
      title="このマッチが間違っていれば GitHub に報告 — 番組情報入りの Issue が新タブで開きます"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        textDecoration: 'none',
        color: 'var(--fg-muted)',
      }}
    >
      <Icon name="external" size={12} />
      <span>マッチを報告</span>
    </a>
  );
}

export function DebugDetailsModal({ program: p, recordingId, onRefresh, onClose }: DebugDetailsModalProps) {
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

  // Portal to <body> so the parent (GuidePanel sets transform: translate
  // and creates a containing block for fixed descendants) can't clip or
  // reposition this overlay.
  return createPortal(
    <div
      className="modal-backdrop"
      style={{ zIndex: 110 }}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        // Only close this sub-modal — don't let the click bubble.
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
            {row(
              'program.id',
              p.id ? <IdValue text={`programs.id = ${p.id}`} display={p.id} /> : null,
            )}
            {row(
              'recording.id',
              recordingId
                ? <IdValue text={`recordings.id = ${recordingId}`} display={recordingId} />
                : null,
            )}
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
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  margin: '10px 0 6px',
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--fg-subtle)',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                  }}
                >
                  TVDB match
                </div>
                {p.id && (
                  <RematchButton programId={p.id} onRefresh={onRefresh} />
                )}
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
                {row(
                  'tvdb.id',
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <a
                      href={tvdbHomepage(tvdb)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        ...mono,
                        color: 'var(--accent)',
                        textDecoration: 'underline',
                        textUnderlineOffset: 2,
                      }}
                    >
                      {tvdb.id}
                    </a>
                    <CopyIconButton text={`tvdb_entries.id = ${tvdb.id}`} />
                  </span>,
                )}
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
          <ReportMatchButton program={p} />
          <div className="spacer" />
          <button
            className="btn"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
