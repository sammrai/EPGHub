-- Eliminate `tvdb_entries.episodes` jsonb column.
--
-- Episodes are no longer DB-persisted: the FileCache layer
-- (`${TVDB_CACHE_DIR}/detail/series:<id>`) is the single source of truth,
-- with a status-driven TTL (continuing → 2d, ended → 30d). All readers
-- now call `tvdbService.getSeriesEpisodes(id)` which routes through
-- `client.getSeriesExtended` and the FileCache.
--
-- Dropping the column is non-destructive: episodes are reconstructible
-- from TVDB on demand. Existing rows simply lose the redundant snapshot.
-- See CLAUDE.md "TVDB cache strategy".

ALTER TABLE "tvdb_entries" DROP COLUMN IF EXISTS "episodes";
