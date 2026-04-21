import { z } from '@hono/zod-openapi';

// Zod shapes for the GPU probe / settings admin endpoints. Kept in sync
// with services/gpuProbeService.ts — any encoder added there must also be
// added to GpuEncoderSchema.

export const GpuEncoderSchema = z
  .enum([
    'h264_nvenc', 'hevc_nvenc',
    'h264_vaapi', 'hevc_vaapi',
    'h264_qsv',   'hevc_qsv',
    'h264_videotoolbox', 'hevc_videotoolbox',
  ])
  .openapi('GpuEncoder');

export const GpuProbeDetailSchema = z
  .object({
    ok: z.boolean().openapi({ description: 'この encoder が 0.5s テスト encode に成功したか' }),
    error: z.string().optional().openapi({
      description: '失敗時の短い ffmpeg エラー (stderr 末尾 3 行まで)',
    }),
  })
  .openapi('GpuProbeDetail');

export const GpuProbeResultSchema = z
  .object({
    available: z.array(GpuEncoderSchema).openapi({
      description: 'ok=true だった encoder の一覧 (details から射影)',
    }),
    details: z.record(GpuEncoderSchema, GpuProbeDetailSchema).openapi({
      description: '8 encoder 全ての試行結果 (未検出でも key は必ず存在する)',
    }),
    probedAt: z.string().datetime({ offset: true }).openapi({
      description: 'probe を走らせた時刻 (ISO-8601)',
    }),
  })
  .openapi('GpuProbeResult');

export const GpuStatusSchema = z
  .object({
    enabled: z.boolean().openapi({
      description: '録画エンコード時に GPU プリセットへ自動昇格するか',
    }),
    preferred: GpuEncoderSchema.nullable().openapi({
      description: 'enabled=true 時に使う encoder。null なら resolvePreset は何もしない',
    }),
    lastProbe: GpuProbeResultSchema.nullable().openapi({
      description: '直近の probe 結果。未実行なら null',
    }),
  })
  .openapi('GpuStatus');

export const GpuSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    preferred: GpuEncoderSchema.nullable().optional(),
  })
  .openapi('GpuSettingsPatch');

export type GpuEncoderSchemaType = z.infer<typeof GpuEncoderSchema>;
export type GpuProbeResultSchemaType = z.infer<typeof GpuProbeResultSchema>;
export type GpuStatusSchemaType = z.infer<typeof GpuStatusSchema>;
export type GpuSettingsPatchSchemaType = z.infer<typeof GpuSettingsPatchSchema>;
