import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { TvdbEntrySchema, TvdbListSchema } from '../schemas/tvdb.ts';
import { ErrorSchema } from '../schemas/common.ts';
import { tvdbService } from '../services/tvdbService.ts';
import { db } from '../db/client.ts';
import { tvdbEntries } from '../db/schema.ts';

export const tvdbRouter = new OpenAPIHono();

// Cached per-season episode descriptor. Mirrors the jsonb shape we persist in
// tvdb_entries.episodes, re-exposed so the UI can build S/E pickers without
// re-fetching from TVDB.
const TvdbEpisodeSchema = z
  .object({
    s: z.number().int().openapi({ example: 2 }),
    e: z.number().int().openapi({ example: 14 }),
    aired: z.string().optional().openapi({ example: '2026-04-19' }),
    name: z.string().optional().openapi({ example: 'それぞれの春' }),
  })
  .openapi('TvdbEpisode');

const TvdbEpisodeListSchema = z.array(TvdbEpisodeSchema).openapi('TvdbEpisodeList');

const TvdbCatalogSchema = z.record(z.string(), TvdbEntrySchema).openapi('TvdbCatalog', {
  description: 'Program.series キー → TvdbEntry のマップ。UI 側の「この番組のTVDB紐付け」参照で使う。',
});

const search = createRoute({
  method: 'get',
  path: '/tvdb/search',
  tags: ['tvdb'],
  summary: 'TVDB 検索',
  description: 'シリーズ/映画をタイトルで検索。キーワード未指定時は全件返す (fixture 動作)。',
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: '検索語 (部分一致)' }),
    }),
  },
  responses: {
    200: { description: 'ヒット一覧', content: { 'application/json': { schema: TvdbListSchema } } },
  },
});

const byId = createRoute({
  method: 'get',
  path: '/tvdb/{id}',
  tags: ['tvdb'],
  summary: 'TVDB 詳細 (ID指定)',
  request: {
    params: z.object({
      id: z.coerce.number().int().openapi({ param: { in: 'path' }, example: 389042 }),
    }),
  },
  responses: {
    200: { description: 'エントリ', content: { 'application/json': { schema: TvdbEntrySchema } } },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

const catalog = createRoute({
  method: 'get',
  path: '/tvdb',
  tags: ['tvdb'],
  summary: 'TVDB カタログ (series キーでマップ)',
  description: 'Program.series と一致するキーで TvdbEntry が得られる。Fixture 提供者の実装上、登録済みの紐付けのみ返る。',
  responses: {
    200: { description: 'カタログ', content: { 'application/json': { schema: TvdbCatalogSchema } } },
  },
});

tvdbRouter.openapi(search, async (c) => {
  const { q } = c.req.valid('query');
  return c.json(await tvdbService.search(q ?? ''), 200);
});

tvdbRouter.openapi(catalog, async (c) => {
  const map = await tvdbService.catalog();
  return c.json(map, 200);
});

tvdbRouter.openapi(byId, async (c) => {
  const { id } = c.req.valid('param');
  const entry = await tvdbService.getById(id);
  if (!entry) return c.json({ code: 'tvdb.not_found', message: '該当なし' }, 404);
  return c.json(entry, 200);
});

const episodes = createRoute({
  method: 'get',
  path: '/tvdb/{id}/episodes',
  tags: ['tvdb'],
  summary: 'TVDB シリーズのエピソード一覧',
  description:
    'tvdb_entries.episodes にキャッシュされた aired-order エピソード配列を返す。UI の「話数選択」プルダウン向け。キャッシュ未ヒット時は空配列。',
  request: {
    params: z.object({
      id: z.coerce.number().int().openapi({ param: { in: 'path' }, example: 389042 }),
    }),
  },
  responses: {
    200: { description: 'エピソード一覧', content: { 'application/json': { schema: TvdbEpisodeListSchema } } },
  },
});

tvdbRouter.openapi(episodes, async (c) => {
  const { id } = c.req.valid('param');
  const [row] = await db
    .select({ episodes: tvdbEntries.episodes })
    .from(tvdbEntries)
    .where(eq(tvdbEntries.tvdbId, id))
    .limit(1);
  return c.json(row?.episodes ?? [], 200);
});
