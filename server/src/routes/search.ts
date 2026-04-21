import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { SearchResultSchema } from '../schemas/search.ts';
import { ErrorSchema } from '../schemas/common.ts';
import { searchService } from '../services/searchService.ts';

export const searchRouter = new OpenAPIHono();

const globalSearch = createRoute({
  method: 'get',
  path: '/search',
  tags: ['search'],
  summary: 'グローバル検索',
  description:
    '番組 / TVDB シリーズ / チャンネル / ルール / 録画を横断して部分一致検索する。' +
    '各セクション毎に上限件数で絞って返す。q が空ならすべて空配列。',
  request: {
    query: z.object({
      q: z.string().openapi({ description: '検索クエリ (空文字可)' }),
      limit: z
        .coerce
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .openapi({ description: 'セクション毎の最大件数 (1..25, 既定 8)' }),
    }),
  },
  responses: {
    200: {
      description: 'グループ化された検索結果',
      content: { 'application/json': { schema: SearchResultSchema } },
    },
    500: { description: '内部エラー', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

searchRouter.openapi(globalSearch, async (c) => {
  const { q, limit } = c.req.valid('query');
  const result = await searchService.search({ q, limit });
  return c.json(result, 200);
});
