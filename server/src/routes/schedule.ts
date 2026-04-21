import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { ProgramListSchema } from '../schemas/program.ts';
import { ErrorSchema } from '../schemas/common.ts';
import { programService } from '../services/programService.ts';

export const scheduleRouter = new OpenAPIHono();

const listSchedule = createRoute({
  method: 'get',
  path: '/schedule',
  tags: ['schedule'],
  summary: '番組表',
  description:
    '指定された「放送日 (JST 05:00 境界)」の番組を時刻順で返す。' +
    '放送日 = 日本の番組表慣習 (翌日 05:00 までを同じ日付として扱う、例: 4/19 25時=4/20 01:00 JST)。' +
    ' date 未指定時は現在の放送日、all=1 で全期間。',
  request: {
    query: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .openapi({ description: 'YYYY-MM-DD (放送日)。未指定なら今日の放送日' }),
      all: z.enum(['0', '1']).optional(),
    }),
  },
  responses: {
    200: { description: '番組の配列', content: { 'application/json': { schema: ProgramListSchema } } },
    500: { description: '内部エラー', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

scheduleRouter.openapi(listSchedule, async (c) => {
  const { date, all } = c.req.valid('query');
  if (all === '1') {
    return c.json(await programService.list(), 200);
  }
  const day = date ?? jstBroadcastDayToday();
  // 放送日 D = 実時刻 JST [D 05:00, D+1 05:00) の区間。深夜番組 (翌日 01:00 等)
  // も D の番組として返る。EPG 表示で「4/20 の 29時 (=翌 4/21 05:00)」を
  // 自然に扱える境界。programService.listInRange は UTC ms を受けるので換算。
  const start = Date.parse(`${day}T05:00:00+09:00`);
  const end = start + 24 * 60 * 60 * 1000;
  return c.json(await programService.listInRange(start, end), 200);
});

/**
 * 今の放送日を返す (日本の TV 編成慣習、JST 05:00 境界)。
 *  - 2026-04-20 04:59 JST → 放送日 2026-04-19
 *  - 2026-04-20 05:00 JST → 放送日 2026-04-20
 */
function jstBroadcastDayToday(): string {
  // JST 時刻から 5 時間引いて日付成分を取る。jstBroadcastDay (matchService)
  // と同じ規則。時刻はシステムタイム基準で判定。
  const d = new Date(Date.now() + (9 - 5) * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
