import type PgBoss from 'pg-boss';
import {
  QUEUE,
  type DiskSweepJob,
  type EncodeJob,
  type EpgLivePollJob,
  type RankingSyncJob,
  type RecordStartJob,
  type RecordStopJob,
  type RuleExpandJob,
  type ThumbnailJob,
} from './queue.ts';

// Worker handlers — the actual recording/encoding plumbing lives here.
// record.start/stop fire at margin-adjusted timestamps and drive the
// `recordings` row through its lifecycle. encode runs ffmpeg and updates
// the same row to 'ready' or 'failed'. epg.refresh + rule.expand +
// ranking.sync are wired for real.

async function handleRecordStart(jobs: PgBoss.Job<RecordStartJob>[]): Promise<void> {
  const { startRecording } = await import('../recording/recorder.ts');
  for (const job of jobs) {
    try {
      await startRecording(job.data.recordingId);
    } catch (err) {
      console.error(`[record.start] ${job.data.recordingId} failed:`, err);
    }
  }
}

async function handleRecordStop(jobs: PgBoss.Job<RecordStopJob>[]): Promise<void> {
  const { stopRecording } = await import('../recording/recorder.ts');
  for (const job of jobs) {
    try {
      await stopRecording(job.data.recordingId);
    } catch (err) {
      console.error(`[record.stop] ${job.data.recordingId} failed:`, err);
    }
  }
}

async function handleEncode(jobs: PgBoss.Job<EncodeJob>[]): Promise<void> {
  const { db } = await import('../db/client.ts');
  const { recordings } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const { runEncode } = await import('../recording/encoder.ts');
  const { defaultPreset, isPresetName, PRESETS } = await import('../recording/encodePresets.ts');
  const {
    setEncodeStarted,
    setEncodeProgress,
    setEncodeFinal,
    setEncodeFailed,
  } = await import('../services/recordingService.ts');
  const { boss: pgBoss } = await import('./queue.ts');

  for (const job of jobs) {
    const { recordingId } = job.data;
    const [row] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
    if (!row) {
      console.warn(`[encode] ${recordingId}: recording row missing, skipping`);
      continue;
    }

    const requested = job.data.preset;
    const presetName =
      requested && isPresetName(requested) ? requested : defaultPreset();
    if (requested && !isPresetName(requested)) {
      console.warn(`[encode] ${recordingId}: unknown preset "${requested}", falling back to ${presetName}`);
    }

    // Input = rawFilename if set, otherwise current filename.
    const inputPath = row.rawFilename ?? row.filename;
    if (!inputPath) {
      await setEncodeFailed(recordingId, 'no input file path on recording row').catch(() => undefined);
      continue;
    }

    await setEncodeStarted(recordingId, presetName).catch((err) => {
      console.error(`[encode] ${recordingId}: failed to mark started:`, err);
    });

    console.log(`[encode] ${recordingId} preset=${presetName} input=${inputPath}`);

    try {
      const result = await runEncode({
        inputPath,
        preset: presetName,
        onProgress: async (p) => {
          await setEncodeProgress(recordingId, p).catch(() => undefined);
        },
        progressIntervalMs: 5000,
      });

      if (result.ok) {
        await setEncodeFinal({
          id: recordingId,
          filename: result.outputPath,
          endedAt: new Date(),
          preset: presetName,
        });
        console.log(
          `[encode] ${recordingId} done → ${result.outputPath} (raw ${result.rawDeleted ? 'deleted' : 'kept'}, ext=${PRESETS[presetName].ext})`
        );
        // Hand off to the thumbnail worker. Fire-and-forget — a failure to
        // enqueue shouldn't roll back the successful encode.
        try {
          await pgBoss.send(QUEUE.THUMBNAIL, { recordingId });
        } catch (err) {
          console.warn(
            `[encode] ${recordingId}: failed to enqueue thumbnail:`,
            (err as Error).message
          );
        }
      } else {
        await setEncodeFailed(recordingId, result.error);
        console.error(`[encode] ${recordingId} failed: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await setEncodeFailed(recordingId, msg).catch(() => undefined);
      console.error(`[encode] ${recordingId} crashed:`, err);
    }
  }
}

async function handleEpgRefresh(jobs: PgBoss.Job<Record<string, never>>[]): Promise<void> {
  const { scheduleService } = await import('../services/scheduleService.ts');
  const { matchService } = await import('../services/matchService.ts');
  for (const _ of jobs) {
    const { count } = await scheduleService.refresh();
    const { resolved, missed } = await matchService.enrichUnmatched();
    console.log(
      `[epg.refresh] upserted=${count} tvdb resolved=${resolved} missed=${missed}`
    );
  }
}

async function handleRuleExpand(jobs: PgBoss.Job<RuleExpandJob>[]): Promise<void> {
  const { expandRules } = await import('../services/ruleExpander.ts');
  for (const _ of jobs) {
    const summary = await expandRules();
    console.log(
      `[rule.expand] matched=${summary.matchedPrograms} created=${summary.createdRecordings} ` +
        `duplicate=${summary.conflicts.duplicate} tunerFull=${summary.conflicts.tunerFull}`
    );
  }
}

async function handleRankingSync(jobs: PgBoss.Job<RankingSyncJob>[]): Promise<void> {
  const { rankingService } = await import('../services/rankingService.ts');
  for (const _ of jobs) {
    try {
      const { genres, rows } = await rankingService.syncAll();
      console.log(`[ranking.sync] genres=${genres} rows=${rows}`);
    } catch (err) {
      console.warn('[ranking.sync] failed', (err as Error).message);
    }
  }
}

// Program-extension polling fallback. Fires every minute; each run diffs
// active/imminent recordings against the programs table (and, when
// MIRAKURUN_URL is set, against a fresh /api/programs fetch). Equivalent
// coverage to the SSE path, so the system degrades gracefully when the
// stream is unavailable.
export async function handleEpgLivePoll(jobs: PgBoss.Job<EpgLivePollJob>[]): Promise<void> {
  const { epgLiveService } = await import('../services/epgLiveService.ts');
  for (const _ of jobs) {
    try {
      const { shifted, touched } = await epgLiveService.pollOnce();
      if (touched > 0) {
        console.log(`[epg.live.poll] touched=${touched} shifted=${shifted.join(',') || '-'}`);
      }
    } catch (err) {
      console.warn('[epg.live.poll] failed:', (err as Error).message);
    }
  }
}

// Extract a JPEG frame from the finished recording. Uses the encoded mp4
// when available (preferred — keyframe alignment is better) and falls back
// to `rawFilename` when the encoder was skipped via keepRaw.
async function handleThumbnail(jobs: PgBoss.Job<ThumbnailJob>[]): Promise<void> {
  const { db } = await import('../db/client.ts');
  const { recordings } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const { generateThumbnail } = await import('../recording/thumbnailer.ts');
  const { basename, dirname, join } = await import('node:path');
  const { stat } = await import('node:fs/promises');

  for (const job of jobs) {
    const { recordingId } = job.data;
    const [row] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
    if (!row) {
      console.warn(`[thumbnail] ${recordingId}: recording row missing, skipping`);
      continue;
    }
    let input = row.filename || row.rawFilename || '';
    if (!input) {
      console.warn(`[thumbnail] ${recordingId}: no input path on recording row`);
      continue;
    }

    try {
      await stat(input);
    } catch {
      const [fresh] = await db
        .select()
        .from(recordings)
        .where(eq(recordings.id, recordingId))
        .limit(1);
      const refetched = fresh?.filename || fresh?.rawFilename || '';
      if (refetched && refetched !== input) {
        try {
          await stat(refetched);
          console.warn(
            `[thumbnail] ${recordingId}: original input ${input} missing, using refetched ${refetched}`
          );
          input = refetched;
        } catch {
          const msg = `input missing after refetch (${refetched}); will retry`;
          console.warn(`[thumbnail] ${recordingId}: ${msg}`);
          throw new Error(msg);
        }
      } else {
        const msg = `input missing (${input}) and no alternate on row; will retry`;
        console.warn(`[thumbnail] ${recordingId}: ${msg}`);
        throw new Error(msg);
      }
    }

    const stem = basename(input).replace(/\.[^.]+$/, '');
    const output = join(dirname(input), `${stem}.jpg`);

    const ok = await generateThumbnail(input, output, 60);
    if (!ok) {
      console.warn(`[thumbnail] ${recordingId}: generation failed for ${input}`);
      continue;
    }
    await db
      .update(recordings)
      .set({ thumb: output, thumbGenerated: true })
      .where(eq(recordings.id, recordingId));
    console.log(`[thumbnail] ${recordingId} → ${output}`);
  }
}

// Hourly disk-space sweep. Delegates entirely to capacityService so the
// threshold + deletion policy live in one place.
async function handleDiskSweep(jobs: PgBoss.Job<DiskSweepJob>[]): Promise<void> {
  const { capacityService } = await import('../services/capacityService.ts');
  for (const _ of jobs) {
    try {
      const res = await capacityService.sweep();
      if (res.deletedIds.length > 0) {
        console.log(
          `[disk.sweep] deleted=${res.deletedIds.length} freed=${res.freedBytes} bytes`
        );
      }
    } catch (err) {
      console.warn('[disk.sweep] failed:', (err as Error).message);
    }
  }
}

export async function registerWorkers(boss: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUE)) {
    await boss.createQueue(name);
  }

  await boss.work<RecordStartJob>(QUEUE.RECORD_START, { batchSize: 4 }, handleRecordStart);
  await boss.work<RecordStopJob>(QUEUE.RECORD_STOP, { batchSize: 4 }, handleRecordStop);
  await boss.work<EncodeJob>(QUEUE.ENCODE, { batchSize: 2 }, handleEncode);
  await boss.work(QUEUE.EPG_REFRESH, { batchSize: 1 }, handleEpgRefresh);
  await boss.work<RuleExpandJob>(QUEUE.RULE_EXPAND, { batchSize: 1 }, handleRuleExpand);
  await boss.work<RankingSyncJob>(QUEUE.RANKING_SYNC, { batchSize: 1 }, handleRankingSync);
  await boss.work<EpgLivePollJob>(QUEUE.EPG_LIVE_POLL, { batchSize: 1 }, handleEpgLivePoll);
  await boss.work<ThumbnailJob>(QUEUE.THUMBNAIL, { batchSize: 1 }, handleThumbnail);
  await boss.work<DiskSweepJob>(QUEUE.DISK_SWEEP, { batchSize: 1 }, handleDiskSweep);

  // Refresh EPG every 10 minutes (JST).
  await boss.schedule(QUEUE.EPG_REFRESH, '*/10 * * * *', {}, { tz: 'Asia/Tokyo' });
  await boss.schedule(QUEUE.RULE_EXPAND, '*/10 * * * *', {}, { tz: 'Asia/Tokyo' });
  await boss.schedule(QUEUE.RANKING_SYNC, '0 */3 * * *', {}, { tz: 'Asia/Tokyo' });
  await boss.schedule(QUEUE.EPG_LIVE_POLL, '* * * * *', {}, { tz: 'Asia/Tokyo' });
  await boss.schedule(QUEUE.DISK_SWEEP, '0 * * * *', {}, { tz: 'Asia/Tokyo' });

  await boss.send(QUEUE.EPG_REFRESH, {});
  await boss.send(QUEUE.RULE_EXPAND, {});
  await boss.send(QUEUE.RANKING_SYNC, {});
}
