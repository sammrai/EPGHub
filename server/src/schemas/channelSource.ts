import { z } from '@hono/zod-openapi';

// ChannelSource — a registered upstream device. Two kinds:
//   'mirakurun' : Mirakurun REST + SSE endpoint (single URL). Full EPG.
//   'iptv'      : m3u playlist + optional XMLTV guide URL (Plex-style,
//                 HDHomeRun-compatible). Works for Mirakurun's /api/iptv
//                 endpoints or any third-party IPTV provider.

export const ChannelSourceKindSchema = z
  .enum(['mirakurun', 'iptv'])
  .openapi('ChannelSourceKind', { description: 'デバイス種別' });

export const ChannelSourceSchema = z
  .object({
    id: z.number().int().openapi({ example: 1 }),
    name: z.string().openapi({ example: 'IPTV JP' }),
    kind: ChannelSourceKindSchema,
    url: z.string().url().openapi({ example: 'http://mirakurun:40772/api/iptv' }),
    xmltvUrl: z
      .string()
      .url()
      .nullable()
      .openapi({
        example: 'http://mirakurun:40772/api/iptv/xmltv',
        description: 'iptv kind のみ。番組表 XMLTV フィードの URL (任意)',
      }),
    // HDHomeRun /discover.json payload — populated when the iptv upstream
    // implements the HDHomeRun HTTP protocol. Mirakurun, tvheadend, Channels,
    // and most commercial IPTV providers do.
    friendlyName: z.string().nullable().openapi({ example: 'Mirakurun' }),
    model: z.string().nullable().openapi({ example: 'Mirakurun' }),
    deviceId: z.string().nullable().openapi({ example: 'A1B2C3D4' }),
    tunerCount: z.number().int().nullable().openapi({ example: 8 }),
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
    url: z.string().url().openapi({ example: 'http://mirakurun:40772/api/iptv' }),
    xmltvUrl: z
      .string()
      .url()
      .nullable()
      .optional()
      .openapi({
        example: 'http://mirakurun:40772/api/iptv/xmltv',
        description: 'iptv kind のみ。番組表 XMLTV フィードの URL',
      }),
  })
  .openapi('CreateChannelSource');

export const ChannelSourceSyncResultSchema = z
  .object({
    channelCount: z.number().int(),
    error: z.string().optional(),
  })
  .openapi('ChannelSourceSyncResult');

export const ProbeChannelSourceSchema = z
  .object({
    url: z.string().url().openapi({ example: 'http://mirakurun:40772/api/iptv' }),
  })
  .openapi('ProbeChannelSource');

// Result of auto-probing a prospective m3u / iptv URL. Used by the add-device
// UI to pre-fill metadata + suggest a likely XMLTV URL before the user saves.
export const ProbeChannelSourceResultSchema = z
  .object({
    reachable: z.boolean(),
    friendlyName: z.string().nullable(),
    model: z.string().nullable(),
    tunerCount: z.number().int().nullable(),
    suggestedXmltvUrl: z.string().nullable(),
    /** Free-form label we guessed for the UI (e.g. "Mirakurun"), or null. */
    inferredKind: z.string().nullable(),
  })
  .openapi('ProbeChannelSourceResult');

export const ScannedDeviceSchema = z
  .object({
    kind: ChannelSourceKindSchema,
    url: z.string(),
    friendlyName: z.string().nullable(),
    model: z.string().nullable(),
    tunerCount: z.number().int().nullable(),
    label: z.string(),
    suggestedXmltvUrl: z.string().nullable(),
  })
  .openapi('ScannedDevice');

export const ScanResultSchema = z
  .object({ devices: z.array(ScannedDeviceSchema) })
  .openapi('ScanResult');

export type ChannelSourceKind = z.infer<typeof ChannelSourceKindSchema>;
export type ChannelSource = z.infer<typeof ChannelSourceSchema>;
export type CreateChannelSource = z.infer<typeof CreateChannelSourceSchema>;
export type ChannelSourceSyncResult = z.infer<typeof ChannelSourceSyncResultSchema>;
export type ProbeChannelSource = z.infer<typeof ProbeChannelSourceSchema>;
export type ProbeChannelSourceResult = z.infer<typeof ProbeChannelSourceResultSchema>;
export type ScannedDevice = z.infer<typeof ScannedDeviceSchema>;
export type ScanResult = z.infer<typeof ScanResultSchema>;
