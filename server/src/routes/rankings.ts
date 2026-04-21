import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { RankingGenreSchema, RankingListSchema } from '../schemas/ranking.ts';
import { ErrorSchema } from '../schemas/common.ts';
import { rankingService } from '../services/rankingService.ts';

export const rankingsRouter = new OpenAPIHono();

const list = createRoute({
  method: 'get',
  path: '/rankings',
  tags: ['rankings'],
  summary: '予約ランキング (JCOM由来)',
  description:
    'JCOM TV ガイドの予約ランキングをキャッシュして返す。'
    + ' `genre` 未指定時は `all` (総合)。3時間ごとに裏でバックグラウンド同期される。',
  request: {
    query: z.object({
      genre: RankingGenreSchema.optional().openapi({
        description: "'all' で総合ランキング。未指定時も 'all'。",
      }),
    }),
  },
  responses: {
    200: {
      description: 'ランキング (順位昇順)',
      content: { 'application/json': { schema: RankingListSchema } },
    },
    500: {
      description: '内部エラー',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

rankingsRouter.openapi(list, async (c) => {
  const { genre } = c.req.valid('query');
  const result = await rankingService.list(genre ?? 'all');
  return c.json(result, 200);
});
