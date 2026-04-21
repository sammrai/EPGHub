import { z } from '@hono/zod-openapi';
import { GenreSchema } from './genre.ts';
import { TvdbEntrySchema } from './tvdb.ts';

export const ProgramSchema = z
  .object({
    id: z.string().openapi({ example: 'nhk-g_2026-04-19T20:00' }),
    ch: z.string().openapi({ example: 'nhk-g' }),
    startAt: z.string().datetime({ offset: true }).openapi({ example: '2026-04-19T20:00:00+09:00' }),
    endAt: z.string().datetime({ offset: true }).openapi({ example: '2026-04-19T20:45:00+09:00' }),
    title: z.string().openapi({ example: '大河ドラマ「風の群像」第16回' }),
    genre: GenreSchema,
    ep: z.string().nullable().openapi({ example: '#16' }),
    series: z.string().nullable().openapi({ example: 'taiga-2026' }),
    hd: z.boolean().optional(),
    desc: z.string().optional(),
    // ARIB extended descriptor: arbitrary key-value pairs populated by the
    // broadcaster — cast, staff, music, episode subtitle, etc. Flat record
    // because the ARIB spec leaves the key set open-ended.
    extended: z.record(z.string(), z.string()).optional().openapi({
      example: { '出演者': '主演:…', 'スタッフ': '脚本:…' },
    }),
    // Video resolution reported by the broadcaster, e.g. "1080i", "720p".
    video: z.string().optional().openapi({ example: '1080i' }),
    // TVDB match for this program, populated by the auto-matcher when the
    // title resolves to an entry. Field is omitted when no match exists.
    tvdb: TvdbEntrySchema.optional(),
    // TVDB season / episode / episode name for this specific program.
    // Resolved at match time by looking up the episode whose `aired` date
    // equals the program's JST calendar date. Null when lookup failed.
    tvdbSeason:  z.number().int().nullable().optional(),
    tvdbEpisode: z.number().int().nullable().optional(),
    tvdbEpisodeName: z.string().nullable().optional(),
  })
  .openapi('Program');

export const ProgramListSchema = z.array(ProgramSchema).openapi('ProgramList');

export type Program = z.infer<typeof ProgramSchema>;
