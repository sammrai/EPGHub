-- R0: Unify reserves + recorded into a single `recordings` table.
-- Previously the lifecycle was split across two state machines
-- (reserves.state: scheduled→recording→done, recorded.state:
-- queued→encoding→ready/failed) requiring the UI to fuzzy-match rows by
-- channel + startAt to surface "真の" state. Replaced by one row/one
-- state per task.
--
-- Existing data is test-only; we drop both tables cleanly. FK in drop_logs
-- is rewritten to point at recordings.

-- drop_logs references recorded.id → rewire to recordings.id. Drop the old
-- FK + column first so the subsequent DROP TABLE recorded succeeds.
ALTER TABLE "drop_logs" DROP CONSTRAINT IF EXISTS "drop_logs_recorded_id_recorded_id_fk";
ALTER TABLE "drop_logs" DROP COLUMN IF EXISTS "recorded_id";

DROP TABLE IF EXISTS "reserves";
DROP TABLE IF EXISTS "recorded";

CREATE TABLE "recordings" (
  "id"                   text                        PRIMARY KEY NOT NULL,
  "program_id"           text                        NOT NULL,
  "ch"                   text                        NOT NULL,
  "title"                text                        NOT NULL,
  "start_at"             timestamp with time zone    NOT NULL,
  "end_at"               timestamp with time zone    NOT NULL,
  "priority"             varchar(8)                  NOT NULL DEFAULT 'medium',
  "quality"              varchar(8)                  NOT NULL DEFAULT '1080i',
  "keep_raw"             boolean                     NOT NULL DEFAULT false,
  "margin_pre"           integer                     NOT NULL DEFAULT 0,
  "margin_post"          integer                     NOT NULL DEFAULT 30,
  "source_kind"          varchar(8)                  NOT NULL DEFAULT 'once',
  "source_rule_id"       integer                     REFERENCES "rules"("id") ON DELETE SET NULL,
  "source_tvdb_id"       integer,
  "state"                varchar(16)                 NOT NULL DEFAULT 'scheduled',
  "allocated_tuner_idx"  integer,
  "retry_count"          integer                     NOT NULL DEFAULT 0,
  "recorded_at"          timestamp with time zone,
  "filename"             text,
  "raw_filename"         text,
  "size"                 double precision,
  "duration"             integer,
  "encode_progress"      double precision,
  "encode_preset"        text,
  "encode_started_at"    timestamp with time zone,
  "encode_ended_at"      timestamp with time zone,
  "encode_error"         text,
  "thumb"                text,
  "thumb_generated"      boolean                     NOT NULL DEFAULT false,
  "protected"            boolean                     NOT NULL DEFAULT false,
  "new"                  boolean                     NOT NULL DEFAULT false,
  "tvdb_id"              integer,
  "series"               text,
  "season"               integer,
  "ep"                   integer,
  "ep_title"             text,
  "rule_matched"         text,
  "original_start_at"    timestamp with time zone,
  "original_end_at"      timestamp with time zone,
  "extended_by_sec"      integer                     NOT NULL DEFAULT 0,
  "created_at"           timestamp with time zone    NOT NULL DEFAULT now(),
  "updated_at"           timestamp with time zone    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "recordings_state_idx"    ON "recordings"("state");
CREATE INDEX IF NOT EXISTS "recordings_start_at_idx" ON "recordings"("start_at");
CREATE INDEX IF NOT EXISTS "recordings_ch_idx"       ON "recordings"("ch");
CREATE INDEX IF NOT EXISTS "recordings_tvdb_idx"     ON "recordings"("tvdb_id");

-- Reintroduce drop_logs.recording_id pointing at the new table. Existing
-- rows are wiped (test-only data) so we can add the NOT NULL column cleanly.
TRUNCATE "drop_logs";
ALTER TABLE "drop_logs"
  ADD COLUMN "recording_id" text NOT NULL,
  ADD CONSTRAINT "drop_logs_pk" PRIMARY KEY ("recording_id"),
  ADD CONSTRAINT "drop_logs_recording_id_recordings_id_fk"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE CASCADE;
