-- Link channels to the owning channel_source so device deletion cascades
-- cleanly. `source` (kind label) is retained — it still drives sync-pipeline
-- branching — but `source_id` is the authoritative ownership edge.

ALTER TABLE "channels"
  ADD COLUMN "source_id" integer REFERENCES "channel_sources"("id") ON DELETE CASCADE;

-- Backfill: tie existing channels to the most recent matching source.
-- Kind mapping mirrors the sync pipelines:
--   channels.source = 'mirakurun' ← channel_sources.kind = 'mirakurun'
--   channels.source = 'm3u'       ← channel_sources.kind = 'iptv'
UPDATE "channels" c
SET "source_id" = (
  SELECT cs."id" FROM "channel_sources" cs
  WHERE (c."source" = 'mirakurun' AND cs."kind" = 'mirakurun')
     OR (c."source" = 'm3u'        AND cs."kind" = 'iptv')
  ORDER BY cs."created_at" DESC
  LIMIT 1
);

-- Orphan sweep: channels whose owning source has been deleted (or was never
-- registered). programs cascade-delete via programs_ch_channels_id_fk.
DELETE FROM "channels" WHERE "source_id" IS NULL;
