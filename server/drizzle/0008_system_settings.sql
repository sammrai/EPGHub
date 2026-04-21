-- Generic key/value store for runtime system settings. Introduced for the
-- GPU encode toggle (R4) so admins can flip `gpu.enabled` / `gpu.preferred`
-- and cache the last ffmpeg probe result (`gpu.lastProbe`) without needing a
-- new typed table per setting. `value` is jsonb so each key can carry
-- whatever shape it needs; see services/gpuProbeService.ts for the GPU keys.
CREATE TABLE IF NOT EXISTS system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
