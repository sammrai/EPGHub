import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ChannelListSchema, ChannelSchema, UpdateChannelSchema } from '../schemas/channel.ts';
import { ErrorSchema } from '../schemas/common.ts';
import { channelService } from '../services/channelService.ts';

export const channelsRouter = new OpenAPIHono();

const listChannels = createRoute({
  method: 'get',
  path: '/channels',
  tags: ['channels'],
  summary: '放送局一覧',
  description:
    'DB の channels テーブルを返す。任意の source (例 "mirakurun" / "m3u") でフィルタできる。',
  request: {
    query: z.object({
      source: z.string().optional().openapi({ example: 'mirakurun' }),
    }),
  },
  responses: {
    200: {
      description: '放送局の配列',
      content: { 'application/json': { schema: ChannelListSchema } },
    },
    500: {
      description: '内部エラー',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

const patchChannel = createRoute({
  method: 'patch',
  path: '/channels/{id}',
  tags: ['channels'],
  summary: '放送局の有効化トグル',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateChannelSchema } },
    },
  },
  responses: {
    200: {
      description: '更新後の放送局',
      content: { 'application/json': { schema: ChannelSchema } },
    },
    404: {
      description: '存在しない id',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

channelsRouter.openapi(listChannels, async (c) => {
  const { source } = c.req.valid('query');
  const channels = await channelService.list({ source });
  return c.json(channels, 200);
});

channelsRouter.openapi(patchChannel, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const updated = await channelService.update(id, body);
  if (!updated) {
    return c.json({ code: 'not_found', message: `channel ${id} not found` }, 404);
  }
  return c.json(updated, 200);
});
