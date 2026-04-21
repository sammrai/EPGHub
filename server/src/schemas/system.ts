import { z } from '@hono/zod-openapi';

export const StorageStatusSchema = z
  .object({
    totalBytes: z.number().int(),
    usedBytes: z.number().int(),
  })
  .openapi('StorageStatus');

export const SystemStatusSchema = z
  .object({
    storage: StorageStatusSchema,
    upcomingReserves: z.number().int().openapi({ description: '本日残り予約件数' }),
    today: z.string().openapi({ example: '2026-04-19', description: '表示基準日 (YYYY-MM-DD)' }),
    version: z.string(),
  })
  .openapi('SystemStatus');

export type SystemStatus = z.infer<typeof SystemStatusSchema>;
