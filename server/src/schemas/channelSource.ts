import { z } from '@hono/zod-openapi';

// ChannelSource — a registered upstream origin that populates the channels
// table. `m3u` rows fetch an extended-m3u playlist and map entries to
// channels; `mirakurun` rows call the Mirakurun API and reuse the existing
// service → channel adapter.

export const ChannelSourceKindSchema = z
  .enum(['m3u', 'mirakurun'])
  .openapi('ChannelSourceKind', { description: 'チャンネルソース種別' });

export const ChannelSourceSchema = z
  .object({
    id: z.number().int().openapi({ example: 1 }),
    name: z.string().openapi({ example: 'IPTV JP' }),
    kind: ChannelSourceKindSchema,
    url: z.string().url().openapi({ example: 'https://example.com/iptv.m3u' }),
    enabled: z.boolean().openapi({ example: true }),
    lastSyncAt: z.string().datetime({ offset: true }).nullable(),
    lastError: z.string().nullable(),
    channelCount: z.number().int().openapi({
      description: '前回の sync で登録できたチャンネル件数',
    }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .openapi('ChannelSource');

export const ChannelSourceListSchema = z.array(ChannelSourceSchema).openapi('ChannelSourceList');

export const CreateChannelSourceSchema = z
  .object({
    name: z.string().min(1).openapi({ example: 'IPTV JP' }),
    kind: ChannelSourceKindSchema,
    url: z.string().url().openapi({ example: 'https://example.com/iptv.m3u' }),
  })
  .openapi('CreateChannelSource');

export const ChannelSourceSyncResultSchema = z
  .object({
    channelCount: z.number().int(),
    error: z.string().optional(),
  })
  .openapi('ChannelSourceSyncResult');

export type ChannelSourceKind = z.infer<typeof ChannelSourceKindSchema>;
export type ChannelSource = z.infer<typeof ChannelSourceSchema>;
export type CreateChannelSource = z.infer<typeof CreateChannelSourceSchema>;
export type ChannelSourceSyncResult = z.infer<typeof ChannelSourceSyncResultSchema>;
