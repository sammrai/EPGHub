-- Rename kind 'm3u' → 'iptv' (Plex-style umbrella for m3u + optional XMLTV),
-- and add xmltv_url to channel_sources so iptv devices can pull program guide
-- data alongside their m3u playlist.
--
-- Mirakurun rows are untouched. m3u-only devices become iptv devices with
-- xmltv_url = NULL (no guide). Follow-up: sync path reads xmltv_url and
-- upserts programs via the new xmltv parser.

ALTER TABLE channel_sources
  ADD COLUMN xmltv_url      text,
  ADD COLUMN friendly_name  text,
  ADD COLUMN model          text,
  ADD COLUMN device_id      text,
  ADD COLUMN tuner_count    integer;

UPDATE channel_sources SET kind = 'iptv' WHERE kind = 'm3u';
