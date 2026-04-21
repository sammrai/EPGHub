import { z } from '@hono/zod-openapi';

export const BcTypeSchema = z
  .enum(['GR', 'BS', 'CS'])
  .openapi('BcType', { description: '受信形態' });

export const ChannelSchema = z
  .object({
    id: z.string().openapi({ example: 'nhk-g' }),
    name: z.string().openapi({ example: 'NHK総合' }),
    short: z.string().openapi({ example: 'NHK G' }),
    number: z.string().openapi({ example: '011', description: 'リモコン番号等の表示用番号' }),
    type: BcTypeSchema,
    color: z
      .string()
      .openapi({ example: 'oklch(0.55 0.12 28)', description: 'UI 上の識別色 (CSS color)' }),
    enabled: z.boolean().openapi({ example: true, description: '録画対象として有効か' }),
    source: z
      .string()
      .openapi({ example: 'mirakurun', description: '生成元デバイスの kind 相当値' }),
  })
  .openapi('Channel');

export const ChannelListSchema = z.array(ChannelSchema).openapi('ChannelList');

export const UpdateChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .openapi('UpdateChannel');

export type BcType = z.infer<typeof BcTypeSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;
