import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { SystemStatusSchema } from '../schemas/system.ts';
import { systemService } from '../services/systemService.ts';

export const systemRouter = new OpenAPIHono();

const status = createRoute({
  method: 'get',
  path: '/system',
  tags: ['system'],
  summary: 'システムステータス (ストレージ・予約件数・バージョン)',
  responses: {
    200: { description: 'ステータス', content: { 'application/json': { schema: SystemStatusSchema } } },
  },
});

systemRouter.openapi(status, async (c) => c.json(await systemService.status(), 200));
