import { z } from '@hono/zod-openapi';

// Unified Recording schema — merges the previous Reserve + Recorded shapes.
// One row represents one "record this thing" task from scheduled creation
// through recording, encoding, and the final ready/failed resting state.
// Result fields (recordedAt, filename, size, duration, encode*, thumb*)
// are nullable/optional because they're populated as the state machine
// progresses — a row in state=scheduled has none of them, a row in
// state=ready has all of them.

export const PrioritySchema = z.enum(['high', 'medium', 'low']).openapi('Priority');
export const QualitySchema = z.enum(['1080i', '720p']).openapi('Quality');

export const RecordingSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once') }),
  z.object({ kind: z.literal('rule'),   ruleId: z.number().int() }),
  z.object({ kind: z.literal('series'), tvdbId: z.number().int() }),
]).openapi('RecordingSource');

// Single state machine spanning plan → recording → encoding → terminal.
//   scheduled  = future, not yet recording
//   recording  = live stream capture in progress
//   encoding   = capture complete, ffmpeg running
//   ready      = final artifact on disk (encoded mp4 or kept-raw ts)
//   failed     = any terminal failure (record or encode)
//   conflict   = allocator couldn't fit a tuner slot
export const RecordingStateSchema = z
  .enum(['scheduled', 'recording', 'encoding', 'ready', 'failed', 'conflict'])
  .openapi('RecordingState');

// Per-recording TS drop summary, attached when the caller asks for it
// (/recordings/{id}/drops and list endpoints that opt in).
export const RecordingDropSummarySchema = z
  .object({
    errorCnt: z.number().int().nonnegative(),
    dropCnt: z.number().int().nonnegative(),
    scramblingCnt: z.number().int().nonnegative(),
  })
  .openapi('RecordingDropSummary');

export const RecordingSchema = z
  .object({
    id: z.string().openapi({ example: 'rec_01HX...' }),

    // ---- Plan ----
    programId: z.string().openapi({ example: 'nhk-g_2026-04-19T20:00' }),
    ch: z.string(),
    title: z.string(),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),

    // ---- Reserve attrs ----
    priority: PrioritySchema,
    quality: QualitySchema,
    keepRaw: z.boolean().openapi({ description: 'TS (raw) を保持するか' }),
    marginPre: z.number().int().openapi({ example: 0, description: '開始前マージン(秒)' }),
    marginPost: z.number().int().openapi({ example: 30, description: '終了後マージン(秒)' }),
    source: RecordingSourceSchema,

    // ---- State ----
    state: RecordingStateSchema,
    allocatedTunerIdx: z.number().int().optional(),

    // ---- Recording result (populated once state >= recording) ----
    recordedAt: z.string().datetime({ offset: true }).nullable().optional(),
    filename: z.string().nullable().optional(),
    size: z.number().nullable().optional().openapi({ description: 'ファイルサイズ(GB)' }),
    duration: z.number().int().nullable().optional().openapi({ description: '録画時間(分)' }),

    // ---- Encode ----
    encodeProgress: z.number().min(0).max(1).optional(),
    encodePreset: z.string().nullable().optional(),
    encodeError: z.string().nullable().optional(),

    // ---- Post-processing ----
    thumb: z.string().nullable().optional(),
    thumbGenerated: z.boolean().optional().openapi({
      description: 'ffmpeg サムネが生成済みなら true。false の場合 thumb は TVDB ポスター等のフォールバック。',
    }),
    protected: z.boolean().optional().openapi({
      description: 'true の行は自動ディスク sweep の対象外。',
    }),
    new: z.boolean().optional(),

    // ---- TVDB / match metadata ----
    tvdbId: z.number().int().nullable().optional(),
    series: z.string().nullable().optional(),
    season: z.number().int().nullable().optional(),
    ep: z.number().int().nullable().optional(),
    epTitle: z.string().nullable().optional(),
    ruleMatched: z.string().nullable().optional(),

    // ---- EIT shift ----
    originalStartAt: z.string().datetime({ offset: true }).nullable().optional(),
    originalEndAt: z.string().datetime({ offset: true }).nullable().optional(),
    extendedBySec: z.number().int().optional(),

    // ---- Opt-in drop summary ----
    drops: RecordingDropSummarySchema.optional(),
  })
  .openapi('Recording');

export const RecordingListSchema = z.array(RecordingSchema).openapi('RecordingList');

export const CreateRecordingSchema = z
  .object({
    programId: z.string(),
    priority: PrioritySchema.default('medium'),
    quality: QualitySchema.default('1080i'),
    keepRaw: z.boolean().default(false),
    marginPre: z.number().int().default(0),
    marginPost: z.number().int().default(30),
    source: RecordingSourceSchema.default({ kind: 'once' }),
    // Force-create over a duplicate/conflict warning.
    force: z.boolean().default(false),
  })
  .openapi('CreateRecording');

export const UpdateRecordingSchema = z
  .object({
    priority: PrioritySchema.optional(),
    quality: QualitySchema.optional(),
    keepRaw: z.boolean().optional(),
    marginPre: z.number().int().min(0).max(600).optional(),
    marginPost: z.number().int().min(0).max(600).optional(),
  })
  .openapi('UpdateRecording');

export type Recording = z.infer<typeof RecordingSchema>;
export type CreateRecording = z.infer<typeof CreateRecordingSchema>;
export type UpdateRecording = z.infer<typeof UpdateRecordingSchema>;
export type RecordingState = z.infer<typeof RecordingStateSchema>;
