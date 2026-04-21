import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { scheduleService } from '../services/scheduleService.ts';
import { matchService } from '../services/matchService.ts';
import { expandRules } from '../services/ruleExpander.ts';
import { recordedHistoryService } from '../services/recordedHistoryService.ts';
import { capacityService } from '../services/capacityService.ts';
import { epgLiveService } from '../services/epgLiveService.ts';
import { channelSyncService } from '../services/channelSyncService.ts';
import {
  probeGpu,
  getGpuStatus,
  setGpuSettings,
} from '../services/gpuProbeService.ts';
import {
  ChannelSourceListSchema,
  ChannelSourceSchema,
  ChannelSourceSyncResultSchema,
  CreateChannelSourceSchema,
} from '../schemas/channelSource.ts';
import {
  GpuProbeResultSchema,
  GpuStatusSchema,
  GpuSettingsPatchSchema,
} from '../schemas/gpuProbe.ts';
import { ErrorSchema } from '../schemas/common.ts';

export const adminRouter = new OpenAPIHono();

// -----------------------------------------------------------------
// Manual triggers for scheduled jobs. Both endpoints are synchronous —
// they run the same code pg-boss crons would fire, just on demand. The
// response echoes back the resulting counts so the UI can show a toast
// with "N件更新" instead of a bare "ok".
// -----------------------------------------------------------------

const RefreshEpgResultSchema = z
  .object({
    programsUpserted: z.number().int().openapi({
      description: 'Mirakurun から取得して upsert した番組件数',
    }),
    tvdbResolved: z.number().int().openapi({
      description: 'TVDB 突き合わせで解決できた番組件数',
    }),
    tvdbMissed: z.number().int().openapi({
      description: 'TVDB 突き合わせで解決できなかった番組件数',
    }),
  })
  .openapi('AdminRefreshEpgResult');

const ExpandSummarySchema = z
  .object({
    matchedPrograms: z.number().int(),
    createdRecordings: z.number().int(),
    conflicts: z.object({
      duplicate: z.number().int(),
      tunerFull: z.number().int(),
    }),
  })
  .openapi('AdminExpandRulesResult');

const refreshEpg = createRoute({
  method: 'post',
  path: '/admin/refresh-epg',
  tags: ['admin'],
  summary: 'EPG を今すぐ更新',
  description:
    '通常は pg-boss が 10 分ごとに実行している scheduleService.refresh() + '
    + 'matchService.enrichUnmatched() をその場で同期実行する。完了まで返らないので'
    + '大規模な番組表取得では数秒〜数十秒かかりうる。',
  responses: {
    200: {
      description: '更新結果',
      content: { 'application/json': { schema: RefreshEpgResultSchema } },
    },
  },
});

const expandRulesRoute = createRoute({
  method: 'post',
  path: '/admin/expand-rules',
  tags: ['admin'],
  summary: 'ルールを今すぐ展開',
  description:
    '全ての有効なルールに対して ruleExpander を即時実行し、マッチする未予約の番組を予約化する。'
    + '既存の GET /rules/expand と同じ動作だが、副作用のある操作は POST が正式。',
  responses: {
    200: {
      description: '展開サマリ',
      content: { 'application/json': { schema: ExpandSummarySchema } },
    },
  },
});

adminRouter.openapi(refreshEpg, async (c) => {
  const refreshed = await scheduleService.refresh();
  const enriched = await matchService.enrichUnmatched();
  return c.json(
    {
      programsUpserted: refreshed.count,
      tvdbResolved: enriched.resolved,
      tvdbMissed: enriched.missed,
    },
    200
  );
});

adminRouter.openapi(expandRulesRoute, async (c) => {
  const summary = await expandRules();
  return c.json(summary, 200);
});

// -----------------------------------------------------------------
// Recorded history: dedupe ledger consulted by the rule expander. The
// rebuild endpoint seeds the ledger from existing `recorded` rows
// (useful right after the P4 migration lands). The list endpoint is
// a thin debug view — not used by the UI today, but useful for
// verifying dedupe behavior via curl.
// -----------------------------------------------------------------

const RecordedHistorySchema = z
  .object({
    id: z.number().int(),
    tvdbId: z.number().int().nullable(),
    season: z.number().int().nullable(),
    episode: z.number().int().nullable(),
    normalizedTitle: z.string().nullable(),
    endAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .openapi('RecordedHistory');

const rebuildHistory = createRoute({
  method: 'post',
  path: '/admin/recorded-history/rebuild',
  tags: ['admin'],
  summary: '録画履歴を recordings テーブルから再構築',
  description:
    'recordings テーブルの ready/failed 行から recorded_history 行を生成する。'
    + '既存の tvdb tuple ユニーク制約で重複行は自動的にスキップされる。',
  responses: {
    200: {
      description: '挿入件数',
      content: {
        'application/json': {
          schema: z.object({ inserted: z.number().int() }).openapi('AdminRebuildHistoryResult'),
        },
      },
    },
  },
});

const listHistory = createRoute({
  method: 'get',
  path: '/admin/recorded-history',
  tags: ['admin'],
  summary: '録画履歴を一覧',
  request: {
    query: z.object({
      tvdbId: z.coerce.number().int().optional().openapi({
        description: '指定時はこの TVDB ID に紐づく行のみ返す',
      }),
      limit: z.coerce.number().int().min(1).max(1000).optional().openapi({
        description: '上限件数 (デフォルト 200)',
      }),
    }),
  },
  responses: {
    200: {
      description: '履歴行 (createdAt 降順)',
      content: {
        'application/json': { schema: z.array(RecordedHistorySchema) },
      },
    },
  },
});

adminRouter.openapi(rebuildHistory, async (c) => {
  const res = await recordedHistoryService.rebuildFromRecorded();
  return c.json(res, 200);
});

adminRouter.openapi(listHistory, async (c) => {
  const { tvdbId, limit } = c.req.valid('query');
  const rows = await recordedHistoryService.list({ tvdbId, limit });
  return c.json(rows, 200);
});

// -----------------------------------------------------------------
// Phase 6: disk capacity. `GET /admin/capacity` is a cheap statfs read
// that the UI can poll; `POST /admin/capacity/sweep` fires the same
// code path the hourly cron uses, returning what was deleted so the
// caller can show a toast.
// -----------------------------------------------------------------

const DiskStatusSchema = z
  .object({
    totalBytes: z.number().int().openapi({ description: 'ファイルシステムの合計容量' }),
    usedBytes: z.number().int().openapi({ description: '使用中のバイト数' }),
    freeBytes: z.number().int().openapi({ description: '空き容量' }),
    threshold: z.number().int().openapi({
      description: 'この値を下回ると sweep が走る閾値 (bytes)',
    }),
  })
  .openapi('DiskStatus');

const SweepResultSchema = z
  .object({
    deletedIds: z.array(z.string()).openapi({
      description: '削除した recordings.id の一覧 (古い順)',
    }),
    freedBytes: z.number().int().openapi({
      description: '削除で解放した推定バイト数 (recordings.size * GiB)',
    }),
  })
  .openapi('DiskSweepResult');

const getCapacity = createRoute({
  method: 'get',
  path: '/admin/capacity',
  tags: ['admin'],
  summary: 'ディスク容量と sweep 閾値を取得',
  description:
    'RECORDING_DIR を含むファイルシステムを statfs(2) で調べ、合計・使用・空き容量と '
    + 'disk.sweep が発動する閾値を返す。閾値は env DISK_SWEEP_MIN_FREE_GB が優先、'
    + '未設定なら total の 5%。',
  responses: {
    200: {
      description: 'ディスク容量サマリ',
      content: { 'application/json': { schema: DiskStatusSchema } },
    },
  },
});

const SweepBodySchema = z
  .object({
    minFreeBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({
        description:
          '閾値のワンショット上書き (bytes)。通常は env DISK_SWEEP_MIN_FREE_GB または総容量の 5% を使うが、'
          + '強制 sweep や e2e テストで任意の閾値を指定したい場合に送る。',
      }),
  })
  .openapi('DiskSweepBody');

const postSweep = createRoute({
  method: 'post',
  path: '/admin/capacity/sweep',
  tags: ['admin'],
  summary: 'ディスク sweep を今すぐ実行',
  description:
    '通常 pg-boss が 1 時間ごとに実行している capacityService.sweep() を同期的に走らせる。'
    + '保護 (protected=true) されていない state=ready/failed の行を古い順に削除し、空き容量が '
    + '閾値を上回ったら停止する。',
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: SweepBodySchema } },
    },
  },
  responses: {
    200: {
      description: '削除結果',
      content: { 'application/json': { schema: SweepResultSchema } },
    },
  },
});

adminRouter.openapi(getCapacity, async (c) => {
  const status = await capacityService.getDiskStatus();
  return c.json(status, 200);
});

adminRouter.openapi(postSweep, async (c) => {
  const body = c.req.valid('json') ?? {};
  const result = await capacityService.sweep(body);
  return c.json(result, 200);
});

// -----------------------------------------------------------------
// Phase 2 live polling. Normally driven by the QUEUE.EPG_LIVE_POLL cron
// (every minute); this endpoint lets admins / e2e tests fire the same
// code path on demand. Invoking pollOnce() in-process also means the
// server's pg-boss client handles rescheduleStop, which would fail in a
// fresh test process where boss.start() hasn't been called.
// -----------------------------------------------------------------

const EpgLivePollResultSchema = z
  .object({
    shifted: z.array(z.string()).openapi({
      description: 'endAt がシフトして再スケジュールされた recording の id 一覧',
    }),
    touched: z.number().int().openapi({
      description: '適用した diff アクション数 (bumpProgramRevision + updateEnd 合算)',
    }),
  })
  .openapi('EpgLivePollResult');

const EpgLivePollBodySchema = z
  .object({
    source: z
      .enum(['auto', 'programs-table'])
      .optional()
      .openapi({
        description:
          "'auto' (省略時): MIRAKURUN_URL があれば Mirakurun fetch → diff、なければ programs-table fallback。"
          + " 'programs-table': Mirakurun を無視し programs テーブルの endAt だけで reserves を同期する"
          + ' (テストで直接 DB を書き換えた場合などに使う)。',
      }),
  })
  .openapi('EpgLivePollBody');

const postEpgLivePoll = createRoute({
  method: 'post',
  path: '/admin/epg-live/poll',
  tags: ['admin'],
  summary: 'EIT live poll を今すぐ実行',
  description:
    '通常 pg-boss が 1 分ごとに走らせている epgLiveService.pollOnce() を同期実行する。'
    + 'MIRAKURUN_URL が設定されていれば Mirakurun /api/programs を再取得して diff、'
    + '未設定なら programs テーブルと reserves.endAt の差分だけ同期する。',
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: EpgLivePollBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'poll 結果',
      content: { 'application/json': { schema: EpgLivePollResultSchema } },
    },
  },
});

adminRouter.openapi(postEpgLivePoll, async (c) => {
  const body = c.req.valid('json') ?? {};
  const result = await epgLiveService.pollOnce({ source: body.source });
  return c.json(result, 200);
});

// -----------------------------------------------------------------
// Channel sources: registered upstream playlists / Mirakurun endpoints
// that feed the channels table. m3u IPTV playlists live alongside the
// env-fixed Mirakurun service — the recorder reads channels.streamUrl
// rather than deriving the URL from the channel id.
// -----------------------------------------------------------------

const listChannelSources = createRoute({
  method: 'get',
  path: '/admin/channel-sources',
  tags: ['admin'],
  summary: 'チャンネルソース一覧',
  description: '登録済みの m3u / Mirakurun アップストリームを取得する。',
  responses: {
    200: {
      description: '登録済みソース (新しい順)',
      content: { 'application/json': { schema: ChannelSourceListSchema } },
    },
  },
});

const createChannelSource = createRoute({
  method: 'post',
  path: '/admin/channel-sources',
  tags: ['admin'],
  summary: 'チャンネルソースを追加',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateChannelSourceSchema } },
    },
  },
  responses: {
    201: {
      description: '追加した行',
      content: { 'application/json': { schema: ChannelSourceSchema } },
    },
    400: {
      description: '入力エラー',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

const syncChannelSource = createRoute({
  method: 'post',
  path: '/admin/channel-sources/{id}/sync',
  tags: ['admin'],
  summary: 'チャンネルソースを今すぐ同期',
  request: {
    params: z.object({ id: z.coerce.number().int() }),
  },
  responses: {
    200: {
      description: 'sync 結果',
      content: { 'application/json': { schema: ChannelSourceSyncResultSchema } },
    },
    404: {
      description: '存在しない id',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

const deleteChannelSource = createRoute({
  method: 'delete',
  path: '/admin/channel-sources/{id}',
  tags: ['admin'],
  summary: 'チャンネルソースを削除',
  request: {
    params: z.object({ id: z.coerce.number().int() }),
  },
  responses: {
    204: { description: '削除完了' },
    404: {
      description: '存在しない id',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(listChannelSources, async (c) => {
  const rows = await channelSyncService.list();
  return c.json(rows, 200);
});

adminRouter.openapi(createChannelSource, async (c) => {
  const body = c.req.valid('json');
  const created = await channelSyncService.create(body);
  return c.json(created, 201);
});

adminRouter.openapi(syncChannelSource, async (c) => {
  const { id } = c.req.valid('param');
  const res = await channelSyncService.syncFromSource(id);
  return c.json(res, 200);
});

adminRouter.openapi(deleteChannelSource, async (c) => {
  const { id } = c.req.valid('param');
  const ok = await channelSyncService.remove(id);
  if (!ok) {
    return c.json({ code: 'not_found', message: `channel_source ${id} not found` }, 404);
  }
  return c.body(null, 204);
});

// -----------------------------------------------------------------
// GPU probe & settings (課題 #26 / R4).
//
// The probe spawns 8 ffmpeg children (one per candidate encoder) in
// parallel with a 5s timeout each. Run on-demand from the Settings page;
// the last result is cached in `system_settings.gpu.lastProbe` so GET
// /admin/gpu/status returns fast. PATCH /admin/gpu/settings flips
// `gpu.enabled` / `gpu.preferred`, which the encoder consults at
// recording-end time via resolvePreset().
// -----------------------------------------------------------------

const postGpuProbe = createRoute({
  method: 'post',
  path: '/admin/gpu/probe',
  tags: ['admin'],
  summary: 'ffmpeg で GPU エンコーダを検出',
  description:
    'NVENC / VAAPI / QSV / VideoToolbox の 8 encoder に対し 0.5 秒の null encode を並列実行し、'
    + 'どの encoder が使えるか返す。結果は system_settings.gpu.lastProbe にキャッシュされる。',
  responses: {
    200: {
      description: 'probe 結果',
      content: { 'application/json': { schema: GpuProbeResultSchema } },
    },
  },
});

const getGpuStatusRoute = createRoute({
  method: 'get',
  path: '/admin/gpu/status',
  tags: ['admin'],
  summary: '現在の GPU 設定と直近 probe 結果',
  description:
    '`enabled` / `preferred` / `lastProbe` を返す。UI の Settings 画面は初期表示でこれを読み、'
    + '必要になったタイミングで `/admin/gpu/probe` を叩く。',
  responses: {
    200: {
      description: 'GPU ステータス',
      content: { 'application/json': { schema: GpuStatusSchema } },
    },
  },
});

const patchGpuSettings = createRoute({
  method: 'patch',
  path: '/admin/gpu/settings',
  tags: ['admin'],
  summary: 'GPU エンコード設定を更新',
  description:
    'enabled/preferred を部分更新する。送らなかった key は変更しない。'
    + ' preferred を null にすると resolvePreset は CPU プリセットにフォールバックする。',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: GpuSettingsPatchSchema } },
    },
  },
  responses: {
    200: {
      description: '更新後のステータス',
      content: { 'application/json': { schema: GpuStatusSchema } },
    },
  },
});

adminRouter.openapi(postGpuProbe, async (c) => {
  const result = await probeGpu();
  return c.json(result, 200);
});

adminRouter.openapi(getGpuStatusRoute, async (c) => {
  const status = await getGpuStatus();
  return c.json(status, 200);
});

adminRouter.openapi(patchGpuSettings, async (c) => {
  const body = c.req.valid('json');
  await setGpuSettings(body);
  const status = await getGpuStatus();
  return c.json(status, 200);
});
