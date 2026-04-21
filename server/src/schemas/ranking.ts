import { z } from '@hono/zod-openapi';
import { TvdbEntrySchema } from './tvdb.ts';

// Keys accepted by GET /rankings?genre=...
// 'all' = JCOM's global ranking board; the rest map to our internal
// ARIB genre keys. Server translates to JCOM hex ids internally.
export const RANKING_GENRE_KEYS = [
  'all',
  'movie',
  'drama',
  'sport',
  'anime',
  'music',
  'var',
  'doc',
  'edu',
] as const;

export const RankingGenreSchema = z
  .enum(RANKING_GENRE_KEYS)
  .openapi('RankingGenre', { example: 'all' });

export const RankingItemSchema = z
  .object({
    rank:        z.number().int().openapi({ example: 1 }),
    title:       z.string(),
    channelName: z.string().nullable().openapi({ description: '次回放送局 — 放送予定が無いとき null' }),
    delta:       z.number().int().nullable().openapi({ description: '前回順位との差 (正=上昇). 新規エントリは null' }),
    quote:       z.string().nullable().openapi({ description: '次回放送の番組名など。なければ null' }),
    nextProgramId: z
      .string()
      .optional()
      .openapi({
        description:
          '次回放送番組の program id (svc-<serviceId>_<startAtIso>). JCOM 側で放送予定を解決できなかった場合は省略',
      }),
    tvdb:        TvdbEntrySchema.nullable(),
    syncedAt:    z.string().datetime().openapi({ description: 'ISO-8601 UTC' }),
  })
  .openapi('RankingItem');

export const RankingListSchema = z
  .object({
    genre: RankingGenreSchema,
    items: z.array(RankingItemSchema),
  })
  .openapi('RankingList');

export type RankingGenre = z.infer<typeof RankingGenreSchema>;
export type RankingItem  = z.infer<typeof RankingItemSchema>;
export type RankingList  = z.infer<typeof RankingListSchema>;
