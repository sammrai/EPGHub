// Shared TVDB poster / backdrop helpers used by Modal and GuidePanel.
import type { CSSProperties } from 'react';
import type { TvdbEntry } from '../data/types';

export function hasPoster(tvdb: TvdbEntry): boolean {
  return !!tvdb.poster && /^https?:\/\//.test(tvdb.poster);
}

export function tvdbHomepage(tvdb: TvdbEntry): string {
  const kind = tvdb.type === 'movie' ? 'movies' : 'series';
  const key = tvdb.slug && tvdb.slug.trim() ? tvdb.slug : String(tvdb.id);
  return `https://thetvdb.com/${kind}/${key}`;
}

export function gradientBg(tvdb: TvdbEntry, variant: 'a' | 'b' = 'a'): string {
  const m = variant === 'b' ? 3 : 2;
  return `linear-gradient(145deg, oklch(0.55 0.14 ${tvdb.id % 360}), oklch(0.32 0.11 ${(tvdb.id * m) % 360}))`;
}

export function posterStyle(tvdb: TvdbEntry): CSSProperties {
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

export function heroBgStyle(tvdb: TvdbEntry): CSSProperties {
  if (hasPoster(tvdb)) {
    return {
      backgroundImage: `url("${tvdb.poster}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    };
  }
  return { background: gradientBg(tvdb) };
}
