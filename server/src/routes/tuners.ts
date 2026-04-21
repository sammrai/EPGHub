import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  DeviceLiveStatusListSchema,
  NowRecordingListSchema,
  TunerAllocationSchema,
  TunerListSchema,
} from '../schemas/tuner.ts';
import { tunerService } from '../services/tunerService.ts';
import { recordingService } from '../services/recordingService.ts';
import { channelService } from '../services/channelService.ts';
import { channelSyncService } from '../services/channelSyncService.ts';
import { snapshotSlots } from '../services/tunerAllocator.ts';
import { fetchAllTunerStatuses } from '../integrations/hdhomerun/tunerStatus.ts';

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

const liveDeviceStatus = createRoute({
  method: 'get',
  path: '/tuners/live',
  tags: ['tuners'],
  summary: 'デバイスごとのチューナー生状態',
  description:
    'iptv デバイスの /discover.json + /tuner{N}/status を直接叩き、物理チューナーごとの使用状況を返す。Plex の Tuner status 相当。',
  responses: {
    200: {
      description: 'デバイス配列 (物理チューナー状態つき)',
      content: { 'application/json': { schema: DeviceLiveStatusListSchema } },
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
tunersRouter.openapi(liveDeviceStatus, async (c) => {
  const sources = await channelSyncService.list();
  // Only probe devices that actually exposed a tuner count via discover.json.
  // Plain m3u sources without HDHomeRun emulation never populate tunerCount,
  // so they're skipped rather than hitting nonexistent tuner endpoints.
  const iptv = sources.filter((s) => s.kind === 'iptv' && (s.tunerCount ?? 0) > 0);
  const out = await Promise.all(
    iptv.map(async (s) => {
      const tuners = await fetchAllTunerStatuses(s.url, s.tunerCount ?? 0);
      return {
        sourceId: s.id,
        name: s.name,
        model: s.model,
        friendlyName: s.friendlyName,
        tunerCount: s.tunerCount ?? 0,
        tuners: tuners.map((t) => ({
          tunerIdx: t.tunerIdx,
          inUse: t.inUse,
          channelName: t.vctName,
          channelNumber: t.vctNumber,
          clientIp: t.targetIp,
        })),
        reachable: tuners.length > 0 || (s.tunerCount ?? 0) === 0,
      };
    })
  );
  return c.json(out, 200);
});
