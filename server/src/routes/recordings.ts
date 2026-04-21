import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import {
  CreateRecordingSchema,
  RecordingListSchema,
  RecordingSchema,
  RecordingDropSummarySchema,
  RecordingStateSchema,
  UpdateRecordingSchema,
} from '../schemas/recording.ts';
import { ErrorSchema } from '../schemas/common.ts';
import {
  recordingService,
  RecordingConflictError,
  getDropLog,
} from '../services/recordingService.ts';
import { stopRecording } from '../recording/recorder.ts';
import { boss, QUEUE } from '../jobs/queue.ts';
import { isPresetName, PRESETS } from '../recording/encodePresets.ts';

// Unified /recordings router. Replaces the prior /reserves + /recorded
// split so the UI and CLI see one state machine: scheduled → recording
// → encoding → ready/failed, with conflict as an allocator-preempted
// side channel.

export const recordingsRouter = new OpenAPIHono();

const ALL_STATES = [
  'scheduled',
  'recording',
  'encoding',
  'ready',
  'failed',
  'conflict',
] as const;

// Comma-separated state filter, e.g. ?state=scheduled,recording.
const StateQueryParam = z
  .string()
  .optional()
  .openapi({
    param: { in: 'query', name: 'state' },
    description:
      `返却する recording の state フィルタ。カンマ区切りで複数指定可 ` +
      `(例: "scheduled,recording")。省略時は全件。有効値: ${ALL_STATES.join('|')}`,
    example: 'scheduled,recording',
  });

const list = createRoute({
  method: 'get',
  path: '/recordings',
  tags: ['recordings'],
  summary: '録画一覧',
  description:
    '全 recording 行を返す。?state= でフィルタ可能 (カンマ区切りで複数)。',
  request: {
    query: z.object({ state: StateQueryParam }),
  },
  responses: {
    200: {
      description: 'recording 配列',
      content: { 'application/json': { schema: RecordingListSchema } },
    },
  },
});

const getOne = createRoute({
  method: 'get',
  path: '/recordings/{id}',
  tags: ['recordings'],
  summary: '録画詳細',
  request: {
    params: z.object({ id: z.string().openapi({ param: { in: 'path' } }) }),
  },
  responses: {
    200: {
      description: 'recording',
      content: { 'application/json': { schema: RecordingSchema } },
    },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

const create = createRoute({
  method: 'post',
  path: '/recordings',
  tags: ['recordings'],
  summary: '録画作成 (予約)',
  description:
    'チューナー競合 (409 tuner-full) または既存重複 (409 duplicate) の場合はエラーを返す。'
    + ' force: true で上書き可能。',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateRecordingSchema } },
    },
  },
  responses: {
    201: { description: 'recording 作成', content: { 'application/json': { schema: RecordingSchema } } },
    409: { description: '競合または重複', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: '番組が見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

const update = createRoute({
  method: 'patch',
  path: '/recordings/{id}',
  tags: ['recordings'],
  summary: 'recording の設定更新',
  description:
    'state=scheduled の recording のみ編集可能。priority/quality/keepRaw/marginPre/marginPost を'
    + ' 部分更新する。margin が変わると pg-boss の RECORD_START/RECORD_STOP を再スケジュールする。',
  request: {
    params: z.object({ id: z.string().openapi({ param: { in: 'path' } }) }),
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateRecordingSchema } },
    },
  },
  responses: {
    200: { description: '更新後', content: { 'application/json': { schema: RecordingSchema } } },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: '編集不可 (scheduled 以外)', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

const remove = createRoute({
  method: 'delete',
  path: '/recordings/{id}',
  tags: ['recordings'],
  summary: 'recording 削除 / キャンセル',
  description:
    '状態に応じて: scheduled=キャンセル, recording=abort, ready/failed=ファイル削除。'
    + ' いずれも DB 行を削除する。',
  request: {
    params: z.object({ id: z.string().openapi({ param: { in: 'path' } }) }),
  },
  responses: {
    204: { description: '削除成功' },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

const stop = createRoute({
  method: 'post',
  path: '/recordings/{id}/stop',
  tags: ['recordings'],
  summary: '録画を即時停止',
  description:
    'state=recording のときのみ有効。アクティブな録画パイプを即座に閉じて .part を本ファイルへ'
    + ' rename し、state を encoding または ready に更新する。',
  request: {
    params: z.object({ id: z.string().openapi({ param: { in: 'path' } }) }),
  },
  responses: {
    204: { description: '停止成功' },
    404: { description: 'recording が見つからない', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: '録画中でない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

// Drop summary for a single recording — full per-PID breakdown.
const DropPerPidSchema = z
  .record(
    z.string(),
    z.object({
      err: z.number().int().nonnegative(),
      drop: z.number().int().nonnegative(),
      scr: z.number().int().nonnegative(),
    })
  )
  .openapi('RecordingDropPerPid');

const RecordingDropLogSchema = z
  .object({
    recordingId: z.string(),
    errorCnt: z.number().int().nonnegative(),
    dropCnt: z.number().int().nonnegative(),
    scramblingCnt: z.number().int().nonnegative(),
    perPid: DropPerPidSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .openapi('RecordingDropLog');

const dropsRoute = createRoute({
  method: 'get',
  path: '/recordings/{id}/drops',
  tags: ['recordings'],
  summary: 'TS ドロップ統計',
  description:
    '録画完了時に記録された TS continuity-counter ベースのドロップ／エラー／'
    + 'スクランブル集計を返す。',
  request: {
    params: z.object({ id: z.string().openapi({ param: { in: 'path' } }) }),
  },
  responses: {
    200: {
      description: 'ドロップ統計',
      content: { 'application/json': { schema: RecordingDropLogSchema } },
    },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

// Force-requeue encode for ready/failed recordings.
const PresetEnumSchema = z.enum(
  Object.keys(PRESETS) as [string, ...string[]]
);

const EncodeBodySchema = z
  .object({
    preset: PresetEnumSchema.optional(),
  })
  .openapi('RecordingEncodeRequest');

const EncodeAcceptedSchema = z
  .object({
    recordingId: z.string(),
    preset: z.string(),
    queued: z.literal(true),
  })
  .openapi('RecordingEncodeAccepted');

const encodeRoute = createRoute({
  method: 'post',
  path: '/recordings/{id}/encode',
  tags: ['recordings'],
  summary: '再エンコードを投入',
  description:
    '指定 preset (省略時は ENCODE_DEFAULT_PRESET) で ffmpeg エンコードを pg-boss のジョブとして投入する。'
    + ' ready / failed の recording に対して使う。',
  request: {
    params: z.object({ id: z.string().openapi({ param: { in: 'path' } }) }),
    body: {
      required: false,
      content: { 'application/json': { schema: EncodeBodySchema } },
    },
  },
  responses: {
    202: {
      description: 'キュー投入済み',
      content: { 'application/json': { schema: EncodeAcceptedSchema } },
    },
    400: { description: 'preset 未知', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

// ---------- handlers ----------

function parseStateFilter(raw: string | undefined): z.infer<typeof RecordingStateSchema>[] | null {
  if (!raw) return null;
  const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = new Set<string>(ALL_STATES);
  const out: z.infer<typeof RecordingStateSchema>[] = [];
  for (const t of tokens) {
    if (valid.has(t)) out.push(t as z.infer<typeof RecordingStateSchema>);
  }
  return out.length > 0 ? out : null;
}

recordingsRouter.openapi(list, async (c) => {
  const { state } = c.req.valid('query');
  const filter = parseStateFilter(state);
  const rows = await recordingService.list(filter ? { state: filter } : undefined);
  return c.json(rows, 200);
});

recordingsRouter.openapi(getOne, async (c) => {
  const { id } = c.req.valid('param');
  const rec = await recordingService.findById(id);
  if (!rec) {
    return c.json({ code: 'recording.not_found', message: 'recording が見つかりません' }, 404);
  }
  return c.json(rec, 200);
});

recordingsRouter.openapi(create, async (c) => {
  const body = c.req.valid('json');
  try {
    const rec = await recordingService.create(body);
    return c.json(rec, 201);
  } catch (e) {
    if (e instanceof RecordingConflictError) {
      if (e.reason === 'program-missing') {
        return c.json(
          { code: 'program.not_found', message: '番組が見つかりません', detail: e.detail },
          404
        );
      }
      const message =
        e.reason === 'tuner-full'
          ? '空きチューナーがありません'
          : '同じ番組の recording がすでにあります';
      return c.json({ code: `recording.${e.reason}`, message, detail: e.detail }, 409);
    }
    throw e;
  }
});

recordingsRouter.openapi(update, async (c) => {
  const { id } = c.req.valid('param');
  const patch = c.req.valid('json');
  const rec = await recordingService.findById(id);
  if (!rec) {
    return c.json({ code: 'recording.not_found', message: 'recording が見つかりません' }, 404);
  }
  if (rec.state !== 'scheduled') {
    return c.json(
      {
        code: 'recording.not_editable',
        message: 'scheduled 状態の recording のみ編集できます',
        detail: { state: rec.state },
      },
      409
    );
  }
  const updated = await recordingService.update(id, patch);
  return c.json(updated, 200);
});

recordingsRouter.openapi(remove, async (c) => {
  const { id } = c.req.valid('param');
  const ok = await recordingService.remove(id);
  if (!ok) {
    return c.json({ code: 'recording.not_found', message: 'recording が見つかりません' }, 404);
  }
  return c.body(null, 204);
});

recordingsRouter.openapi(stop, async (c) => {
  const { id } = c.req.valid('param');
  const rec = await recordingService.findById(id);
  if (!rec) {
    return c.json({ code: 'recording.not_found', message: 'recording が見つかりません' }, 404);
  }
  if (rec.state !== 'recording') {
    return c.json(
      {
        code: 'recording.not_recording',
        message: '録画中の recording のみ停止できます',
        detail: { state: rec.state },
      },
      409
    );
  }
  // stopRecording flushes the pipe, renames .part → .ts, updates the row
  // to encoding|ready. No-op if the handle was lost across restart.
  await stopRecording(id);
  return c.body(null, 204);
});

recordingsRouter.openapi(dropsRoute, async (c) => {
  const { id } = c.req.valid('param');
  const log = await getDropLog(id);
  if (!log) {
    return c.json({ code: 'drops.not_found', message: 'ドロップログが見つかりません' }, 404);
  }
  return c.json(log, 200);
});

recordingsRouter.openapi(encodeRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json') ?? {};

  const rec = await recordingService.findById(id);
  if (!rec) {
    return c.json({ code: 'recording.not_found', message: 'recording が見つかりません' }, 404);
  }

  if (body.preset && !isPresetName(body.preset)) {
    return c.json({ code: 'encode.bad_preset', message: `unknown preset: ${body.preset}` }, 400);
  }

  await boss.send(QUEUE.ENCODE, { recordingId: id, preset: body.preset });

  return c.json(
    {
      recordingId: id,
      preset: body.preset ?? (process.env.ENCODE_DEFAULT_PRESET ?? 'h265-1080p'),
      queued: true as const,
    },
    202
  );
});

// Avoid unused-import lint: RecordingDropSummarySchema is re-exported from
// schemas but referenced indirectly via the list/detail schemas.
void RecordingDropSummarySchema;
