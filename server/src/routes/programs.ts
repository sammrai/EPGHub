import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { ProgramSchema } from '../schemas/program.ts';
import { TvdbEntrySchema } from '../schemas/tvdb.ts';
import { ErrorSchema } from '../schemas/common.ts';
import { programService } from '../services/programService.ts';
import { matchService } from '../services/matchService.ts';

export const programsRouter = new OpenAPIHono();

const idParam = z.object({
  id: z.string().openapi({
    param: { in: 'path' },
    example: 'nhk-g_2026-04-19T20:00:00.000Z',
  }),
});

// --- GET /programs/:id ---------------------------------------------------

const getProgram = createRoute({
  method: 'get',
  path: '/programs/{id}',
  tags: ['programs'],
  summary: '番組1件',
  description: 'プログラム ID で1件返す。TVDB 紐付け済みなら tvdb フィールドが付く。',
  request: { params: idParam },
  responses: {
    200: { description: '番組', content: { 'application/json': { schema: ProgramSchema } } },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

programsRouter.openapi(getProgram, async (c) => {
  const { id } = c.req.valid('param');
  const p = await programService.findById(id);
  if (!p) return c.json({ code: 'programs.not_found', message: '該当なし' }, 404);
  return c.json(p, 200);
});

// --- POST /programs/:id/tvdb --------------------------------------------
// Manual match. Accepts a TVDB id; we fetch the full entry via TvdbService,
// upsert it into tvdb_entries, pin the normalized title in title_overrides
// (user_set=true), and update this program (plus any sibling programs
// sharing the same normalized title) to point at it.

const LinkBody = z.object({
  tvdbId: z.number().int().openapi({ example: 188501 }),
});

const linkTvdb = createRoute({
  method: 'post',
  path: '/programs/{id}/tvdb',
  tags: ['programs'],
  summary: 'TVDB 手動マッチ',
  description:
    '番組を指定 TVDB エントリへ手動で紐付ける。同じ正規化タイトルを持つ番組すべてに波及し、title_overrides に user_set=true で記録される (以降 auto matcher は上書きしない)。',
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: LinkBody } } },
  },
  responses: {
    200: { description: '確定した TVDB エントリ', content: { 'application/json': { schema: TvdbEntrySchema } } },
    400: { description: '不正な TVDB id', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: '番組が見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

programsRouter.openapi(linkTvdb, async (c) => {
  const { id } = c.req.valid('param');
  const { tvdbId } = c.req.valid('json');
  const existing = await programService.findById(id);
  if (!existing) return c.json({ code: 'programs.not_found', message: '該当なし' }, 404);
  try {
    const entry = await matchService.linkProgram(id, tvdbId);
    return c.json(entry, 200);
  } catch (err) {
    return c.json(
      { code: 'tvdb.invalid_id', message: (err as Error).message },
      400
    );
  }
});

// --- DELETE /programs/:id/tvdb ------------------------------------------
// Manual unmatch — pins title_overrides as "no match" so auto matcher leaves
// it alone, and clears programs.tvdb_id for the normalized-title cohort.

const unlinkTvdb = createRoute({
  method: 'delete',
  path: '/programs/{id}/tvdb',
  tags: ['programs'],
  summary: 'TVDB マッチ解除',
  description:
    '番組の TVDB 紐付けを解除する。同じ正規化タイトルの全番組で解除され、title_overrides に tvdbId=null, user_set=true で記録 (auto matcher は以降再紐付けしない)。',
  request: { params: idParam },
  responses: {
    204: { description: '解除完了' },
    404: { description: '番組が見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

programsRouter.openapi(unlinkTvdb, async (c) => {
  const { id } = c.req.valid('param');
  const existing = await programService.findById(id);
  if (!existing) return c.json({ code: 'programs.not_found', message: '該当なし' }, 404);
  await matchService.unlinkProgram(id);
  return c.body(null, 204);
});

// --- PATCH /programs/:id/tvdb-episode -----------------------------------
// Per-airing S/E override. Writes ONLY this one program — no cohort spread.
// When both season+episode are numbers, the server looks up the cached
// episode in tvdb_entries.episodes to populate tvdbEpisodeName. When either
// is null, all three fields are cleared.

const EpisodeBody = z.object({
  season: z.number().int().nullable().openapi({ example: 2 }),
  episode: z.number().int().nullable().openapi({ example: 14 }),
});

const setEpisode = createRoute({
  method: 'patch',
  path: '/programs/{id}/tvdb-episode',
  tags: ['programs'],
  summary: 'TVDB 話数 手動設定',
  description:
    '番組の TVDB シーズン/話数を手動で設定する。自動マッチャーが誤った S/E を割り当てた再放送などに対する per-airing の修正で、同タイトル他番組には波及しない。season/episode のいずれかが null の場合は S/E/名前をクリアする。',
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: EpisodeBody } } },
  },
  responses: {
    200: { description: '更新後の番組', content: { 'application/json': { schema: ProgramSchema } } },
    404: { description: '番組が見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

programsRouter.openapi(setEpisode, async (c) => {
  const { id } = c.req.valid('param');
  const { season, episode } = c.req.valid('json');
  const existing = await programService.findById(id);
  if (!existing) return c.json({ code: 'programs.not_found', message: '該当なし' }, 404);
  await matchService.setProgramEpisode(id, season, episode);
  const updated = await programService.findById(id);
  if (!updated) return c.json({ code: 'programs.not_found', message: '該当なし' }, 404);
  return c.json(updated, 200);
});
