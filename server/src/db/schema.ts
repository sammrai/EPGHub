import { pgTable, text, varchar, timestamp, integer, boolean, doublePrecision, jsonb, serial, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Channels — populated from tuner scan + user config. `streamUrl` is the
// recorder's direct source (Mirakurun service stream, raw IPTV TS URL, …).
// `source` classifies how the row was registered (kind label; kept for the
// pre-FK sync pipeline). `sourceId` points at the channel_sources row that
// owns this channel — on delete, channels + their programs cascade away.
// Nullable only because legacy rows predated the FK; fresh upserts always set it.
export const channels = pgTable('channels', {
  id:     text('id').primaryKey(),
  name:   text('name').notNull(),
  short:  text('short').notNull(),
  number: text('number').notNull(),
  type:   varchar('type', { length: 4 }).notNull(),
  color:  text('color').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  streamUrl: text('stream_url'),
  source:    varchar('source', { length: 16 }).notNull().default('mirakurun'),
  sourceId:  integer('source_id').references(() => channelSources.id, { onDelete: 'cascade' }),
  m3uGroup:  text('m3u_group'),
});

// channel_sources — registered upstream devices. Two kinds:
//   'mirakurun' : Mirakurun REST + SSE endpoint (single URL)
//   'iptv'      : m3u playlist + optional XMLTV guide (Plex-style)
// channelSyncService.syncFromSource(id) fetches the upstream and upserts
// into channels; iptv rows with xmltvUrl also upsert programs.
export const channelSources = pgTable('channel_sources', {
  id:           serial('id').primaryKey(),
  name:         text('name').notNull(),
  kind:         varchar('kind', { length: 16 }).notNull(), // 'mirakurun' | 'iptv'
  url:          text('url').notNull(),
  xmltvUrl:     text('xmltv_url'),
  // HDHomeRun /discover.json metadata — captured for iptv devices when the
  // upstream implements the HDHomeRun HTTP protocol (Mirakurun / tvheadend / …).
  // Nullable because plain m3u providers won't populate them.
  friendlyName: text('friendly_name'),
  model:        text('model'),
  deviceId:     text('device_id'),
  tunerCount:   integer('tuner_count'),
  enabled:      boolean('enabled').notNull().default(true),
  lastSyncAt:   timestamp('last_sync_at', { withTimezone: true }),
  lastError:    text('last_error'),
  channelCount: integer('channel_count').notNull().default(0),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// TVDB catalog. Keyed by the TVDB numeric id (stable across renames).
// Populated by the matcher when a search resolves + by POST /programs/:id/tvdb.
export const tvdbEntries = pgTable('tvdb_entries', {
  tvdbId:    integer('tvdb_id').primaryKey(),
  slug:      text('slug').notNull(),
  kind:      varchar('kind', { length: 8 }).notNull(),   // 'series' | 'movie'
  title:     text('title').notNull(),
  titleEn:   text('title_en').notNull(),
  network:   text('network').notNull(),
  year:      integer('year').notNull(),
  poster:    text('poster').notNull(),
  matchedBy: text('matched_by').notNull(),
  // series-only
  totalSeasons:   integer('total_seasons'),
  currentSeason:  integer('current_season'),
  currentEp:      integer('current_ep'),
  totalEps:       integer('total_eps'),
  status:         varchar('status', { length: 16 }),
  // movie-only
  runtime:   integer('runtime'),
  director:  text('director'),
  rating:    doublePrecision('rating'),
  // TVDB episode list, kept inline so per-program episode lookup doesn't
  // re-hit the TVDB API. Each entry has the aired-order season + number,
  // the airdate (ISO "YYYY-MM-DD"), and optional display name.
  episodes:  jsonb('episodes').$type<Array<{ s: number; e: number; aired?: string; name?: string }>>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Programs — ingested from Mirakurun/XMLTV feed. The UI renders these.
// Upserted on every EPG refresh so tvdbId + tvdbMatchedAt survive restart.
export const programs = pgTable('programs', {
  id:       text('id').primaryKey(),                 // `${ch}_${startAt}` — see services/scheduleService
  ch:       text('ch').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  startAt:  timestamp('start_at', { withTimezone: true }).notNull(),
  endAt:    timestamp('end_at',   { withTimezone: true }).notNull(),
  title:    text('title').notNull(),
  genreKey: varchar('genre_key', { length: 16 }).notNull(),
  ep:       text('ep'),
  series:   text('series'),                          // fixture catalog key — nullable for Mirakurun
  hd:       boolean('hd').notNull().default(false),
  desc:     text('desc'),
  extended: jsonb('extended').$type<Record<string, string>>(),
  video:    varchar('video', { length: 16 }),
  tvdbId:        integer('tvdb_id').references(() => tvdbEntries.tvdbId, { onDelete: 'set null' }),
  tvdbMatchedAt: timestamp('tvdb_matched_at', { withTimezone: true }),
  // Episode derived from the TVDB series' aired-date index. Populated when
  // the matcher (auto or manual) links a series and finds an episode whose
  // `aired` matches the program's JST date.
  tvdbSeason:  integer('tvdb_season'),
  tvdbEpisode: integer('tvdb_episode'),
  tvdbEpisodeName: text('tvdb_episode_name'),
  // Bumped on every EIT[p/f] update we absorb via epgLiveService. Lets clients
  // detect program shifts without diffing every field.
  revision:    integer('revision').notNull().default(0),
});

// Normalized title → tvdb_id map. The matcher's source of truth:
//   - Row exists with tvdbId set  → use this match (auto or user-set)
//   - Row exists with tvdbId null, userSet=true → user dismissed, do not re-match
//   - Row missing                  → run TVDB search
// userSet=false rows can be re-resolved after TTL if a better match appears.
export const titleOverrides = pgTable('title_overrides', {
  normalizedTitle: text('normalized_title').primaryKey(),
  tvdbId:          integer('tvdb_id').references(() => tvdbEntries.tvdbId, { onDelete: 'set null' }),
  userSet:         boolean('user_set').notNull().default(false),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Recording rules (keyword + TVDB-linked series).
export const rules = pgTable('rules', {
  id:         serial('id').primaryKey(),
  name:       text('name').notNull(),
  keyword:    text('keyword').notNull(),
  channels:   jsonb('channels').notNull().$type<string[]>(),
  enabled:    boolean('enabled').notNull().default(true),
  matches:    integer('matches').notNull().default(0),
  nextMatchCh:     text('next_match_ch'),
  nextMatchTitle:  text('next_match_title'),
  nextMatchAt:     timestamp('next_match_at', { withTimezone: true }),
  priority:   varchar('priority', { length: 8 }).notNull().default('medium'),
  quality:    varchar('quality', { length: 8 }).notNull().default('1080i'),
  skipReruns: boolean('skip_reruns').notNull().default(true),
  kind:       varchar('kind', { length: 8 }).notNull().default('keyword'),
  tvdbId:     integer('tvdb_id').references(() => tvdbEntries.tvdbId, { onDelete: 'set null' }),
  // Phase 7 exclusion lists. All nullable in the DB; rowToRule() normalizes
  // null → [] so downstream code always sees arrays. Ported from the shape
  // of EPGStation's ReserveOptionChecker predicates.
  ngKeywords:    jsonb('ng_keywords').$type<string[]>(),
  genreDeny:     jsonb('genre_deny').$type<string[]>(),
  timeRangeDeny: jsonb('time_range_deny').$type<Array<{ start: string; end: string }>>(),
});

// Unified recordings table — represents a single "record this thing" task
// from scheduled creation through recording, encoding, and final ready/failed
// state. Replaces the prior reserves + recorded split, which forced the UI
// to cross-reference two state machines by time/channel heuristics to
// surface the real outcome.
//
// State machine:
//   scheduled  ─(record.start job)───→ recording
//   recording  ─(stop, keepRaw=true)─→ ready
//   recording  ─(stop, keepRaw=false)→ encoding
//   encoding   ─(ffmpeg success)────→ ready
//   any        ─(failure)────────────→ failed
//   scheduled  ─(allocator cannot fit)→ conflict
//
// Fields split by lifecycle stage: plan → reserve attrs → state/execution
// → recording result → encode → post-processing → match metadata → EIT
// shifts. All "result" columns are nullable since they're populated as
// execution progresses.
export const recordings = pgTable('recordings', {
  id:             text('id').primaryKey(),

  // ---- Plan (set at creation, immutable) ----
  programId:      text('program_id').notNull(),
  ch:             text('ch').notNull(),
  title:          text('title').notNull(),
  startAt:        timestamp('start_at', { withTimezone: true }).notNull(),
  endAt:          timestamp('end_at',   { withTimezone: true }).notNull(),

  // ---- Reserve attributes (editable while state=scheduled) ----
  priority:       varchar('priority', { length: 8 }).notNull().default('medium'),
  quality:        varchar('quality', { length: 8 }).notNull().default('1080i'),
  keepRaw:        boolean('keep_raw').notNull().default(false),
  marginPre:      integer('margin_pre').notNull().default(0),
  marginPost:     integer('margin_post').notNull().default(30),

  // ---- Source (where this reserve came from) ----
  sourceKind:     varchar('source_kind', { length: 8 }).notNull().default('once'),
  sourceRuleId:   integer('source_rule_id').references(() => rules.id, { onDelete: 'set null' }),
  sourceTvdbId:   integer('source_tvdb_id'),

  // ---- Unified lifecycle state ----
  state:          varchar('state', { length: 16 }).notNull().default('scheduled'),
  allocatedTunerIdx: integer('allocated_tuner_idx'),
  // Stream-failure retry counter (bumped when fetch body errors in the
  // first few seconds; cap lives in recorder.ts).
  retryCount:     integer('retry_count').notNull().default(0),

  // ---- Recording result (populated once state >= recording) ----
  recordedAt:     timestamp('recorded_at', { withTimezone: true }),
  // `filename` = on-disk path. Written as the raw .ts by the recorder, then
  // overwritten by the encoder worker with the encoded mp4/m4a path on
  // success. `rawFilename` keeps the original .ts pinned so we can clean
  // up / re-encode without extra bookkeeping.
  filename:       text('filename'),
  rawFilename:    text('raw_filename'),
  size:           doublePrecision('size'),        // GB, post-rename
  duration:       integer('duration'),            // minutes

  // ---- Encode ----
  encodeProgress:  doublePrecision('encode_progress'),
  encodePreset:    text('encode_preset'),
  encodeStartedAt: timestamp('encode_started_at', { withTimezone: true }),
  encodeEndedAt:   timestamp('encode_ended_at',   { withTimezone: true }),
  encodeError:     text('encode_error'),

  // ---- Post-processing ----
  thumb:           text('thumb'),
  thumbGenerated:  boolean('thumb_generated').notNull().default(false),
  // Operator-pinned rows are skipped by the disk-sweep worker when free
  // space drops below the configured threshold.
  protected:       boolean('protected').notNull().default(false),
  new:             boolean('new').notNull().default(false),

  // ---- TVDB / match metadata ----
  tvdbId:          integer('tvdb_id'),
  series:          text('series'),
  season:          integer('season'),
  ep:              integer('ep'),
  epTitle:         text('ep_title'),
  ruleMatched:     text('rule_matched'),

  // ---- EIT[p/f] shift tracking ----
  // Captured once on the first shift we apply — lets the UI show "this
  // recording was extended from X → Y" without re-deriving from programs.
  originalStartAt: timestamp('original_start_at', { withTimezone: true }),
  originalEndAt:   timestamp('original_end_at',   { withTimezone: true }),
  // Cumulative seconds gained from program extensions. 0 = untouched.
  extendedBySec:   integer('extended_by_sec').notNull().default(0),

  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// JCOM "予約ランキング" snapshots, grouped by genre key. Each syncAll()
// replaces all rows for each genre — ranks are positional so rows are keyed
// on (genreId, rank). jcomData keeps the raw row for debugging / future
// fields; tvdbId is populated by the matcher service when it resolves.
export const rankings = pgTable(
  'rankings',
  {
    genreId:     varchar('genre_id', { length: 8 }).notNull(),  // 'all' | ARIB hex ('6','3','1'...)
    rank:        integer('rank').notNull(),
    title:       text('title').notNull(),
    channelName: text('channel_name'),
    delta:       integer('delta'),                              // prevRank - rank (positive = up); null for new entries
    quote:       text('quote'),                                 // nextBroadcast title / snippet
    jcomData:    jsonb('jcom_data').notNull(),                  // raw row, for debugging
    tvdbId:      integer('tvdb_id').references(() => tvdbEntries.tvdbId, { onDelete: 'set null' }),
    syncedAt:    timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.genreId, t.rank] }),
  })
);

// Recorded history — dedupe ledger consulted by the rule expander to skip
// episodes we've already recorded. Append-only (never updated). Kept separate
// from `recorded` so deleting a recorded file doesn't erase the "we have
// already seen this episode" signal. Two lookup paths:
//   1. Structured tvdb tuple (tvdbId + season + episode)   — preferred
//   2. normalizedTitle + endAt (± fuzzy window)            — fallback when
//      the program didn't resolve to a TVDB entry
// The partial unique index on the tvdb tuple prevents duplicate rows for the
// same episode; title-fallback rows rely on the caller's idempotency.
export const recordedHistory = pgTable(
  'recorded_history',
  {
    id:              serial('id').primaryKey(),
    tvdbId:          integer('tvdb_id'),
    season:          integer('season'),
    episode:         integer('episode'),
    normalizedTitle: text('normalized_title'),
    endAt:           timestamp('end_at', { withTimezone: true }).notNull(),
    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tvdbUniq: uniqueIndex('recorded_history_tvdb_uniq')
      .on(t.tvdbId, t.season, t.episode)
      .where(sql`${t.tvdbId} IS NOT NULL`),
  })
);

// Generic key/value store for runtime system settings. Introduced for the
// GPU encode toggle (R4): `gpu.enabled` (bool), `gpu.preferred` (encoder
// name | null), and `gpu.lastProbe` (cached GpuProbeResult). Keys are
// namespaced by feature area so we can keep growing the store without
// adding a typed table per setting. See services/gpuProbeService.ts.
export const systemSettings = pgTable('system_settings', {
  key:       text('key').primaryKey(),
  value:     jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Phase 3: per-recording TS drop summary. Populated by the recorder on
// stop() once the final .ts file has been renamed. `perPid` is a jsonb
// map keyed by decimal PID string with { err, drop, scr } counts so the
// UI / CLI can drill into which PID caused the trouble without re-parsing
// the stream. FK → recordings (id stable from scheduled through done).
export const dropLogs = pgTable('drop_logs', {
  recordingId:   text('recording_id')
    .primaryKey()
    .references(() => recordings.id, { onDelete: 'cascade' }),
  errorCnt:      integer('error_cnt').notNull().default(0),
  dropCnt:       integer('drop_cnt').notNull().default(0),
  scramblingCnt: integer('scrambling_cnt').notNull().default(0),
  perPid:        jsonb('per_pid').$type<Record<string, { err: number; drop: number; scr: number }>>(),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
