import PgBoss from 'pg-boss';

// pg-boss is our background worker: it stores jobs in Postgres (own schema),
// polls them in-process, handles retries + cron schedules + concurrency.
// We run workers in the same Node process as the HTTP server — no separate
// worker binary needed. For multi-process later, spawn a second process
// that calls start() + register handlers but skips the API routing.

// Lazy: only fail if callers actually try to use the queue (e.g. boss.start()
// or boss.send()). Allowing this module to be imported without DATABASE_URL
// keeps `gen:openapi` and test helpers working.
export const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL ?? '',
  schema: 'pgboss',
});

// Queue names — keep in one place so route handlers and worker handlers
// don't drift. When adding a queue, register it here and export the handle.
export const QUEUE = {
  /** Start a recording for a specific reserve at startAt − marginPre. */
  RECORD_START: 'record.start',
  /** Stop an in-flight recording at endAt + marginPost. */
  RECORD_STOP: 'record.stop',
  /** Encode a just-finished raw TS into the preset output. */
  ENCODE: 'encode',
  /** Refresh EPG from Mirakurun + re-run the TVDB matcher. */
  EPG_REFRESH: 'epg.refresh',
  /** Walk enabled rules against the current schedule and create matching reserves. */
  RULE_EXPAND: 'rule.expand',
  /** Refresh JCOM 予約ランキング snapshot (+ TVDB matching) for the Discover page. */
  RANKING_SYNC: 'ranking.sync',
  /**
   * Fallback program-extension poll. Runs every minute to re-fetch the
   * Mirakurun /api/programs endpoint for any active/imminent reserve whose
   * programId we track. Mostly a no-op while the SSE EventStream in
   * epgLiveService is healthy; it carries the full load if the stream drops.
   */
  EPG_LIVE_POLL: 'epg.live.poll',
  /**
   * Extract a JPEG frame from a just-finished recording and update
   * `recorded.thumb` + `thumbGenerated=true`. Enqueued by the encode
   * worker on success (falls back to raw TS input if encoding was
   * skipped via keepRaw).
   */
  THUMBNAIL: 'thumbnail',
  /**
   * Hourly cron that checks free disk space against the configured
   * threshold and deletes oldest unprotected recordings until the
   * filesystem is back above the threshold. See services/capacityService.
   */
  DISK_SWEEP: 'disk.sweep',
  /**
   * Force-refresh the FileCache-backed episode list for a specific TVDB
   * show id and re-apply S/E to any programs of that show currently
   * stuck at S/E null. Enqueued reactively by `applyTvdbToPrograms` when
   * a program with an episode marker fails to resolve (Class B miss —
   * cache stale relative to TVDB upstream), and by the safety-net sweep
   * below for continuing shows with upcoming programs. Deduplicated via
   * `singletonKey: tvdb-eps:${tvdbId}` with a 4h cooldown so repeated
   * misses against the same show collapse to one fetch. See CLAUDE.md
   * "TVDB cache strategy".
   */
  TVDB_EPISODES_REFRESH: 'tvdb.episodes.refresh',
  /**
   * Daily safety-net cron: walks continuing shows that have an
   * upcoming program within the next 14 days and enqueues a
   * TVDB_EPISODES_REFRESH job for each. Catches Class B misses that
   * the reactive trigger didn't see (e.g. EPG titles without an
   * episode marker but the show genuinely added new episodes upstream).
   */
  TVDB_EPISODES_SWEEP: 'tvdb.episodes.sweep',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface RecordStartJob {
  recordingId: string;
}
export interface RecordStopJob {
  recordingId: string;
}
export interface EncodeJob {
  recordingId: string;
  /** Preset name from encodePresets.ts. Falls back to ENCODE_DEFAULT_PRESET. */
  preset?: string;
}
export type RuleExpandJob = Record<string, never>;
export type RankingSyncJob = Record<string, never>;
export type EpgLivePollJob = Record<string, never>;
export interface ThumbnailJob {
  recordingId: string;
}
export type DiskSweepJob = Record<string, never>;
export interface TvdbEpisodesRefreshJob {
  tvdbId: number;
}
export type TvdbEpisodesSweepJob = Record<string, never>;
