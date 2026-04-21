import { z } from '@hono/zod-openapi';

const TvdbBase = z.object({
  id: z.number().int().openapi({ example: 389042 }),
  slug: z.string().openapi({ example: 'kaze-no-gunzo' }),
  title: z.string().openapi({ example: '風の群像' }),
  titleEn: z.string().openapi({ example: 'Kaze no Gunzō' }),
  network: z.string(),
  year: z.number().int(),
  poster: z.string().openapi({ description: 'ポスター画像識別子 (URL or internal key)' }),
  matchedBy: z.string(),
});

export const TvdbSeriesSchema = TvdbBase.extend({
  type: z.literal('series'),
  totalSeasons: z.number().int(),
  currentSeason: z.number().int(),
  currentEp: z.number().int(),
  totalEps: z.number().int(),
  status: z.enum(['continuing', 'ended']),
}).openapi('TvdbSeries');

export const TvdbMovieSchema = TvdbBase.extend({
  type: z.literal('movie'),
  runtime: z.number().int().openapi({ description: '本編時間(分)' }),
  director: z.string(),
  rating: z.number().openapi({ example: 9.3 }),
}).openapi('TvdbMovie');

export const TvdbEntrySchema = z
  .discriminatedUnion('type', [TvdbSeriesSchema, TvdbMovieSchema])
  .openapi('TvdbEntry');

export const TvdbListSchema = z.array(TvdbEntrySchema).openapi('TvdbList');

export type TvdbEntry = z.infer<typeof TvdbEntrySchema>;
export type TvdbSeries = z.infer<typeof TvdbSeriesSchema>;
export type TvdbMovie = z.infer<typeof TvdbMovieSchema>;
