import { z } from '@hono/zod-openapi';
import { PrioritySchema, QualitySchema } from './recording.ts';
import { PRESETS, type PresetName } from '../recording/encodePresets.ts';

// Zod shapes for GET/PATCH /admin/settings. Kept tight — the UI only
// exposes the handful of defaults that operators change per-deployment
// plus the TVDB API key used by the v4 integration client.

const PRESET_KEYS = Object.keys(PRESETS) as [PresetName, ...PresetName[]];
const PresetEnumSchema = z.enum(PRESET_KEYS).openapi('RecEncodePreset');

export const RecDefaultsSchema = z
  .object({
    priority:     PrioritySchema,
    quality:      QualitySchema,
    marginPre:    z.number().int().min(0).max(600),
    marginPost:   z.number().int().min(0).max(600),
    keepRaw:      z.boolean(),
    encodePreset: PresetEnumSchema,
  })
  .openapi('RecDefaults');

export const TvdbApiKeyStatusSchema = z
  .object({
    source: z.enum(['db', 'none']).openapi({
      description: 'db: 保存済み, none: 未設定',
    }),
    last4: z.string().nullable().openapi({
      description: '保存キーの末尾4文字 (マスク表示用)。未設定なら null',
    }),
  })
  .openapi('TvdbApiKeyStatus');

export const AdminSettingsSchema = z
  .object({
    rec: RecDefaultsSchema,
    tvdb: z.object({
      apiKey: TvdbApiKeyStatusSchema,
    }),
  })
  .openapi('AdminSettings');

export const AdminSettingsPatchSchema = z
  .object({
    rec: z
      .object({
        priority:     PrioritySchema.optional(),
        quality:      QualitySchema.optional(),
        marginPre:    z.number().int().min(0).max(600).optional(),
        marginPost:   z.number().int().min(0).max(600).optional(),
        keepRaw:      z.boolean().optional(),
        encodePreset: PresetEnumSchema.optional(),
      })
      .optional(),
    tvdb: z
      .object({
        apiKey: z.string().openapi({
          description: 'TVDB v4 APIキー。空文字を送ると保存済みキーを削除する。',
        }).optional(),
      })
      .optional(),
  })
  .openapi('AdminSettingsPatch');

export type AdminSettingsType = z.infer<typeof AdminSettingsSchema>;
export type AdminSettingsPatchType = z.infer<typeof AdminSettingsPatchSchema>;
