import { z } from '@hono/zod-openapi';
import { BcTypeSchema } from './channel.ts';
import { PrioritySchema } from './recording.ts';

export const TunerStateSchema = z
  .object({
    type: BcTypeSchema,
    total: z.number().int().nonnegative(),
    inUse: z.number().int().nonnegative(),
  })
  .openapi('TunerState');

export const TunerListSchema = z.array(TunerStateSchema).openapi('TunerList');

// Informational view of per-physical-tuner recording chains produced by
// the priority allocator. The UI uses it to show "Tuner 2 is booked from
// 19:00 → 21:00 by recording rec_..." without re-implementing allocation
// client-side.
export const TunerSlotRecordingSchema = z
  .object({
    id: z.string(),
    ch: z.string(),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    priority: PrioritySchema,
    title: z.string(),
  })
  .openapi('TunerSlotRecording');

export const TunerSlotSchema = z
  .object({
    tunerIdx: z.number().int().nonnegative(),
    types: z.array(z.enum(['GR', 'BS', 'CS', 'SKY'])),
    recordings: z.array(TunerSlotRecordingSchema),
  })
  .openapi('TunerSlot');

export const TunerAllocationSchema = z
  .object({
    slots: z.array(TunerSlotSchema),
  })
  .openapi('TunerAllocation');

export const NowRecordingSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    ch: z.string(),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    progress: z.number().min(0).max(1),
    series: z.string().nullable(),
    tvdbId: z.number().int().nullable(),
  })
  .openapi('NowRecording');

export const NowRecordingListSchema = z.array(NowRecordingSchema).openapi('NowRecordingList');

// HDHomeRun-style per-tuner live status, fetched on demand from the
// iptv device's /tuner{N}/status endpoint. One entry per physical tuner.
export const DeviceTunerStatusSchema = z
  .object({
    tunerIdx: z.number().int().nonnegative(),
    inUse: z.boolean(),
    /** Channel name the tuner is currently locked to, if any. */
    channelName: z.string().nullable(),
    /** Channel number, HDHomeRun-style (e.g. "1.1"). */
    channelNumber: z.string().nullable(),
    /** IP of the client consuming this tuner's stream, if any. */
    clientIp: z.string().nullable(),
  })
  .openapi('DeviceTunerStatus');

export const DeviceLiveStatusSchema = z
  .object({
    sourceId: z.number().int(),
    name: z.string(),
    model: z.string().nullable(),
    friendlyName: z.string().nullable(),
    tunerCount: z.number().int(),
    tuners: z.array(DeviceTunerStatusSchema),
    /** True when the discover probe last succeeded. */
    reachable: z.boolean(),
  })
  .openapi('DeviceLiveStatus');

export const DeviceLiveStatusListSchema = z
  .array(DeviceLiveStatusSchema)
  .openapi('DeviceLiveStatusList');

export type TunerState = z.infer<typeof TunerStateSchema>;
export type NowRecording = z.infer<typeof NowRecordingSchema>;
export type DeviceTunerStatus = z.infer<typeof DeviceTunerStatusSchema>;
export type DeviceLiveStatus = z.infer<typeof DeviceLiveStatusSchema>;
