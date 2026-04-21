// Shell: Sidebar, Header, Brand, SysWidget
import { Fragment } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import type { SystemInfo } from '../data/types';

export interface SidebarCounts {
  recorded: number;
  rules: number;
  reserves: number;
}

export interface SidebarProps {
  active: string;
  onNav: (id: string) => void;
  counts: SidebarCounts;
  system: SystemInfo;
  recordingCount: number;
}

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  count: number | null;
  recBadge?: number;
}

export function Sidebar({ active, onNav, counts, system, recordingCount }: SidebarProps) {
  const navMain: NavItem[] = [
    { id: 'guide',    label: '番組表',     icon: 'grid',     count: null },
    { id: 'library',  label: 'ライブラリ',  icon: 'disk',     count: counts.recorded },
    { id: 'rules',    label: 'ルール',     icon: 'folder',   count: counts.rules },
  ];
  const navSec: NavItem[] = [
    { id: 'discover', label: '発見',       icon: 'sparkle',  count: null },
    { id: 'reserves', label: '予約・状態',  icon: 'calendar', count: counts.reserves, recBadge: recordingCount },
    { id: 'settings', label: '設定',       icon: 'settings', count: null },
  ];
  const NavBtn = (n: NavItem) => (
    <button
      key={n.id}
      className={`nav-item ${active === n.id ? 'active' : ''}`}
      onClick={() => onNav(n.id)}
    >
      <Icon name={n.icon} size={14} />
      <span>{n.label}</span>
      {n.recBadge != null && n.recBadge > 0 && (
        <span className="nav-badge rec">{n.recBadge}</span>
      )}
      {n.count != null && <span className="count">{n.count}</span>}
    </button>
  );
  return (
    <aside className="sidebar">
      <div>
        <div className="side-section-label">メイン</div>
        <div className="side-group">{navMain.map(NavBtn)}</div>
      </div>
      <div>
        <div className="side-section-label">ツール</div>
        <div className="side-group">{navSec.map(NavBtn)}</div>
      </div>

      <div style={{ flex: 1 }} />

      <SysWidget system={system} />
    </aside>
  );
}

export interface SysWidgetProps {
  system: SystemInfo;
}

export function SysWidget({ system }: SysWidgetProps) {
  const s = system;
  const usedPct = (s.storage.used / s.storage.total) * 100;
  const pips = (total: number, inUse: number) =>
    Array.from({ length: total }, (_, i) => (
      <span key={i} className={`pip ${i < inUse ? 'on' : ''}`} />
    ));
  return (
    <div className="sys-widget">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="sys-row">
          <Icon name="disk" size={12} />
          <span className="label">ストレージ</span>
          <span className="value">{s.storage.used}/{s.storage.total} {s.storage.unit}</span>
        </div>
        <div className="sys-bar"><div className="sys-bar-fill" style={{ width: `${usedPct}%` }} /></div>
      </div>
      <div className="sys-row">
        <Icon name="tuner" size={12} />
        <span className="label">GR</span>
        <div className="tuner-pips">{pips(s.tuners.gr.total, s.tuners.gr.inUse)}</div>
      </div>
      <div className="sys-row">
        <Icon name="tuner" size={12} />
        <span className="label">BS</span>
        <div className="tuner-pips">{pips(s.tuners.bs.total, s.tuners.bs.inUse)}</div>
      </div>
      <div className="sys-row">
        <Icon name="tuner" size={12} />
        <span className="label">CS</span>
        <div className="tuner-pips">{pips(s.tuners.cs.total, s.tuners.cs.inUse)}</div>
      </div>
    </div>
  );
}

export interface HeaderCrumb {
  label: string;
}

export interface HeaderProps {
  page: string;
  crumbs?: HeaderCrumb[];
  onCrumb?: (index: number | null) => void;
  onOpenSearch?: () => void;
  onCreateRule?: () => void;
}

const LINK_BTN_STYLE: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'inherit',
  font: 'inherit',
};

const MUTED_LINK_BTN_STYLE: CSSProperties = {
  ...LINK_BTN_STYLE,
  color: 'var(--fg-muted)',
};

const PAGE_LABELS: Record<string, string> = {
  guide: '番組表',
  library: 'ライブラリ',
  rules: 'ルール',
  reserves: '予約・状態',
  discover: '発見',
  settings: '設定',
};

export function Header({ page, crumbs, onCrumb, onOpenSearch, onCreateRule }: HeaderProps) {
  const label = PAGE_LABELS[page] || '番組表';
  return (
    <header className="header">
      <div className="header-breadcrumb">
        <button onClick={() => onCrumb && onCrumb(null)} style={LINK_BTN_STYLE}>EPGHub</button>
        <span className="sep">/</span>
        {crumbs && crumbs.length > 0 ? (
          <>
            <button onClick={() => onCrumb && onCrumb(0)} style={MUTED_LINK_BTN_STYLE}>{label}</button>
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                <span className="sep">/</span>
                {i === crumbs.length - 1
                  ? <strong>{c.label}</strong>
                  : <button onClick={() => onCrumb && onCrumb(i + 1)} style={MUTED_LINK_BTN_STYLE}>{c.label}</button>}
              </Fragment>
            ))}
          </>
        ) : (
          <strong>{label}</strong>
        )}
      </div>
      <div className="header-spacer" />
      <div className="search" onClick={onOpenSearch}>
        <Icon name="search" size={13} />
        <input readOnly placeholder="番組名・出演者・ジャンル…" />
        <span className="kbd">⌘K</span>
      </div>
      <div className="header-spacer" />
      <button className="header-btn" onClick={onCreateRule}>
        <Icon name="plus" size={13} /> 新規ルール
      </button>
      <button className="header-btn primary">
        <Icon name="bell" size={13} /> 通知
      </button>
    </header>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">E</div>
      <div className="brand-name">EPGHub</div>
      <div className="brand-sub">v{__APP_VERSION__}</div>
    </div>
  );
}
