import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { NowRecordingListSchema, TunerAllocationSchema, TunerListSchema } from '../schemas/tuner.ts';
import { tunerService } from '../services/tunerService.ts';
import { recordingService } from '../services/recordingService.ts';
import { channelService } from '../services/channelService.ts';
import { snapshotSlots } from '../services/tunerAllocator.ts';

export const tunersRouter = new OpenAPIHono();

const listTuners = createRoute({
  method: 'get',
  path: '/tuners',
  tags: ['tuners'],
  summary: 'チューナー稼働状況',
  responses: {
    200: { description: 'チューナー配列', content: { 'application/json': { schema: TunerListSchema } } },
  },
});

const nowRecording = createRoute({
  method: 'get',
  path: '/now-recording',
  tags: ['tuners'],
  summary: '現在録画中の番組',
  responses: {
    200: {
      description: '録画中配列',
      content: { 'application/json': { schema: NowRecordingListSchema } },
    },
  },
});

const allocation = createRoute({
  method: 'get',
  path: '/tuners/allocation',
  tags: ['tuners'],
  summary: '物理チューナーごとの予約割当',
  description:
    '優先度ベースのアロケータが配置した、物理チューナーごとの予約チェーンを返す。UI のデバッグ/表示用。',
  responses: {
    200: {
      description: 'チューナー割当スナップショット',
      content: { 'application/json': { schema: TunerAllocationSchema } },
    },
  },
});

tunersRouter.openapi(listTuners, async (c) => c.json(await tunerService.list(), 200));
tunersRouter.openapi(nowRecording, async (c) => c.json(await tunerService.nowRecording(), 200));
tunersRouter.openapi(allocation, async (c) => {
  // Re-run the allocator on current scheduled + recording rows. Excluding
  // conflict/ready/failed mirrors recordingService.create() so the
  // snapshot matches what the DB actually pinned to allocatedTunerIdx.
  const [rows, devices, channels] = await Promise.all([
    recordingService.list({ state: ['scheduled', 'recording'] }),
    tunerService.devices(),
    channelService.list(),
  ]);
  const slots = snapshotSlots(rows, devices, { channels });
  return c.json({ slots }, 200);
});
