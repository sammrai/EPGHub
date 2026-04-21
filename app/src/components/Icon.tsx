import type { CSSProperties, ReactNode } from 'react';

export type IconName =
  | 'tv' | 'calendar' | 'list' | 'grid' | 'timeline' | 'rec' | 'play'
  | 'search' | 'plus' | 'check' | 'x' | 'chevL' | 'chevR' | 'chevD'
  | 'settings' | 'disk' | 'tuner' | 'filter' | 'sparkle' | 'bell'
  | 'folder' | 'star' | 'info' | 'lightning' | 'clock' | 'menu' | 'arrow'
  | 'external' | 'pencil' | 'link';

export interface IconProps {
  name: IconName;
  size?: number;
  style?: CSSProperties;
  className?: string;
}

const paths: Record<IconName, ReactNode> = {
  tv:        (<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>),
  calendar:  (<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></>),
  list:      (<path d="M3 6h18M3 12h18M3 18h18" />),
  grid:      (<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>),
  timeline:  (<><path d="M3 12h18" /><circle cx="7" cy="12" r="2" /><circle cx="13" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></>),
  rec:       (<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />),
  play:      (<path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />),
  search:    (<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  plus:      (<path d="M12 5v14M5 12h14" />),
  check:     (<path d="M5 12l5 5L20 7" />),
  x:         (<path d="M6 6l12 12M18 6L6 18" />),
  chevL:     (<path d="M15 6l-6 6 6 6" />),
  chevR:     (<path d="M9 6l6 6-6 6" />),
  chevD:     (<path d="M6 9l6 6 6-6" />),
  settings:  (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>),
  disk:      (<><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" /></>),
  tuner:     (<><path d="M4 12h16" /><circle cx="7" cy="12" r="2" fill="currentColor" /><path d="M17 8v8" /></>),
  filter:    (<path d="M3 5h18l-7 9v6l-4-2v-4z" />),
  sparkle:   (<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" fill="currentColor" opacity="0.15" stroke="currentColor" />),
  bell:      (<><path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v3.2a2 2 0 0 1-.6 1.4L4 17h5" /><path d="M9 17a3 3 0 0 0 6 0" /></>),
  folder:    (<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  star:      (<path d="M12 3l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8L6.7 19.6l1-6L3.3 9.4l6-.9z" />),
  info:      (<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.01" /></>),
  lightning: (<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />),
  clock:     (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  menu:      (<path d="M3 6h18M3 12h18M3 18h18" />),
  arrow:     (<path d="M5 12h14M13 5l7 7-7 7" />),
  external:  (<><path d="M14 4h6v6" /><path d="M10 14L20 4" /><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" /></>),
  pencil:    (<><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></>),
  link:      (<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>),
};

export function Icon({ name, size = 14, style, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
    >
      {paths[name]}
    </svg>
  );
}
