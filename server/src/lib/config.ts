// Runtime YAML config loader.
//
// Reads `config/epghub.yaml` (relative to the server root) if it exists,
// validates with zod, and exposes a singleton Config object computed once
// at module load. The file is optional — when absent we return an empty
// config and callers fall back to their existing env-var/defaults paths.
//
// Precedence order (highest wins):
//   1. process.env.*          — shell / systemd / docker-compose overrides
//   2. config/epghub.yaml     — long-lived deployment settings
//   3. hard-coded defaults in the consuming module
//
// The YAML lives for things that shouldn't be in shell env (structured
// preset lists, disk thresholds) but that operators still want to tweak
// without a recompile. Env takes precedence so an ops incident can still
// override a value without editing the file.
//
// EPGStation reference: `src/model/IConfigFile.ts` (interface only).
// We don't port the EPGStation shape 1:1 because our surface is much
// smaller (no multi-DB, no per-user auth, no URL scheme selection).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RecordingConfigSchema = z
  .object({
    dir: z.string().min(1).optional(),
  })
  .strict()
  .optional();

const EncodeConfigSchema = z
  .object({
    defaultPreset: z.string().min(1).optional(),
    concurrency: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const CapacityConfigSchema = z
  .object({
    minFreeGb: z.number().nonnegative().optional(),
    sweepCron: z.string().min(1).optional(),
  })
  .strict()
  .optional();

const FfmpegConfigSchema = z
  .object({
    bin: z.string().min(1).optional(),
    probeBin: z.string().min(1).optional(),
  })
  .strict()
  .optional();

const MirakurunConfigSchema = z
  .object({
    url: z.string().url().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const ConfigSchema = z
  .object({
    recording: RecordingConfigSchema,
    encode: EncodeConfigSchema,
    capacity: CapacityConfigSchema,
    ffmpeg: FfmpegConfigSchema,
    mirakurun: MirakurunConfigSchema,
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Resolve the YAML file path. Fixed relative to the server root so
 * `npm run dev` from any cwd within the project still finds the file.
 * Callers rarely override this; the override exists for tests.
 */
function configPath(): string {
  // The server package lives at /workspaces/epghub/server, and this file
  // at src/lib/config.ts. The YAML sits at server/config/epghub.yaml.
  // `import.meta.dirname` is Node 20.12+; we compute it by hand so Node
  // 18 still boots.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../config/epghub.yaml');
}

function readRaw(path: string): unknown {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  const parsed = YAML.parse(text);
  // An empty file parses to null/undefined — normalize to {} so zod's
  // object schema accepts it.
  return parsed ?? {};
}

function parseConfigFile(path: string): Config {
  try {
    const raw = readRaw(path);
    return ConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new Error(`invalid config at ${path}: ${issues}`);
    }
    throw err;
  }
}

// Singleton, computed once at module load. Subsequent reads are cheap
// object-property lookups. If operators change the YAML at runtime they
// have to restart the process — which matches how env vars work.
let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config === null) {
    _config = parseConfigFile(configPath());
  }
  return _config;
}

/**
 * Test-only: force-reload from a specified path (or the default). Callers
 * outside tests should stick to `loadConfig()`. Not exported via index —
 * accessed via `import` from tests.
 */
export function __reloadConfigForTest(path?: string): Config {
  _config = parseConfigFile(path ?? configPath());
  return _config;
}
