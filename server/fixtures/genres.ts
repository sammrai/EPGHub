import type { Genre } from '../src/schemas/genre.ts';

export const GENRES: Record<string, Genre> = {
  NEWS:  { key: 'news',  label: 'ニュース',      dot: 'oklch(0.6 0.02 250)' },
  DRAMA: { key: 'drama', label: 'ドラマ',         dot: 'oklch(0.62 0.12 20)' },
  ANIME: { key: 'anime', label: 'アニメ',         dot: 'oklch(0.65 0.14 300)' },
  VAR:   { key: 'var',   label: 'バラエティ',     dot: 'oklch(0.7 0.13 80)' },
  SPORT: { key: 'sport', label: 'スポーツ',       dot: 'oklch(0.6 0.14 150)' },
  DOC:   { key: 'doc',   label: 'ドキュメンタリー', dot: 'oklch(0.55 0.08 200)' },
  MUSIC: { key: 'music', label: '音楽',           dot: 'oklch(0.62 0.12 340)' },
  MOVIE: { key: 'movie', label: '映画',           dot: 'oklch(0.5 0.1 40)' },
  INFO:  { key: 'info',  label: '情報',           dot: 'oklch(0.68 0.1 100)' },
  EDU:   { key: 'edu',   label: '教育',           dot: 'oklch(0.6 0.09 160)' },
};
