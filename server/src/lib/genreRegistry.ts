import type { Genre } from '../schemas/genre.ts';

// Static genre registry. Used both when ingesting ARIB lv1 codes from
// Mirakurun (see integrations/mirakurun/adapter.ts) and when hydrating a
// Program row from `programs.genreKey` back into the API shape.
const GENRES: Record<string, Genre> = {
  news:  { key: 'news',  label: 'ニュース',       dot: 'oklch(0.6 0.02 250)' },
  sport: { key: 'sport', label: 'スポーツ',       dot: 'oklch(0.6 0.14 150)' },
  info:  { key: 'info',  label: '情報',           dot: 'oklch(0.68 0.1 100)' },
  drama: { key: 'drama', label: 'ドラマ',         dot: 'oklch(0.62 0.12 20)' },
  music: { key: 'music', label: '音楽',           dot: 'oklch(0.62 0.12 340)' },
  var:   { key: 'var',   label: 'バラエティ',      dot: 'oklch(0.7 0.13 80)' },
  movie: { key: 'movie', label: '映画',           dot: 'oklch(0.5 0.1 40)' },
  anime: { key: 'anime', label: 'アニメ',         dot: 'oklch(0.65 0.14 300)' },
  doc:   { key: 'doc',   label: 'ドキュメンタリー', dot: 'oklch(0.55 0.08 200)' },
  edu:   { key: 'edu',   label: '教育',           dot: 'oklch(0.6 0.09 160)' },
};

const UNKNOWN: Genre = { key: 'info', label: 'その他', dot: 'oklch(0.68 0.1 100)' };

export function genreFromKey(key: string): Genre {
  return GENRES[key] ?? UNKNOWN;
}
