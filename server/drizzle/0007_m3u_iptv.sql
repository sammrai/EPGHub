-- Channels gain a stream URL + source classifier so the recorder doesn't
-- have to derive the URL from the channel id (which only worked for Mirakurun).
ALTER TABLE channels
  ADD COLUMN stream_url text,
  ADD COLUMN source     varchar(16) NOT NULL DEFAULT 'mirakurun',
  ADD COLUMN m3u_group  text;

-- channel_sources: registered upstream playlists / Mirakurun endpoints. The
-- sync service walks each row, fetches the upstream, and upserts into channels.
CREATE TABLE channel_sources (
  id           serial       PRIMARY KEY,
  name         text         NOT NULL,
  kind         varchar(16)  NOT NULL,                -- 'm3u' | 'mirakurun'
  url          text         NOT NULL,
  enabled      boolean      NOT NULL DEFAULT true,
  last_sync_at timestamp with time zone,
  last_error   text,
  channel_count integer     NOT NULL DEFAULT 0,
  created_at   timestamp with time zone NOT NULL DEFAULT now()
);
