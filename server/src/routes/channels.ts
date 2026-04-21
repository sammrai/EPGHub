import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { ChannelListSchema } from '../schemas/channel.ts';
import { ErrorSchema } from '../schemas/common.ts';
import { channelService } from '../services/channelService.ts';

export const channelsRouter = new OpenAPIHono();

const listChannels = createRoute({
  method: 'get',
  path: '/channels',
  tags: ['channels'],
  summary: '放送局一覧',
  description: 'ユーザーがチューナー設定で有効化した放送局の一覧を返す。',
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

channelsRouter.openapi(listChannels, async (c) => {
  const channels = await channelService.list();
  return c.json(channels, 200);
});
