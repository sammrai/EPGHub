// Admin settings service — persists recording defaults and the TVDB API key
// in the existing `system_settings` key/value table. Uses the same lazy DB
// binding pattern as gpuProbeService so modules that don't need a DB
// connection (isolated unit tests) aren't forced to set DATABASE_URL.
//
// Key namespaces:
//   rec.priority, rec.quality, rec.marginPre, rec.marginPost, rec.keepRaw,
//   rec.encodePreset   — defaults merged into CreateRecording inputs
//   tvdb.apiKey        — overrides any prior-process key held by tvdbService
//
// The tvdb.apiKey write path fires a single subscriber so tvdbService can
// drop its cached v4 client and rebuild with the new key on the next call.

import { eq, sql } from 'drizzle-orm';
import type { PresetName } from '../recording/encodePresets.ts';

type DbClient = typeof import('../db/client.ts').db;
type SystemSettings = typeof import('../db/schema.ts').systemSettings;
let _db: DbClient | null = null;
let _systemSettings: SystemSettings | null = null;
async function dbHandles(): Promise<{ db: DbClient; systemSettings: SystemSettings }> {
  if (!_db || !_systemSettings) {
    const client = await import('../db/client.ts');
    const schema = await import('../db/schema.ts');
    _db = client.db;
    _systemSettings = schema.systemSettings;
  }
  return { db: _db, systemSettings: _systemSettings };
}

export type RecPriority = 'high' | 'medium' | 'low';
export type RecQuality  = '1080i' | '720p';

export interface RecDefaults {
  priority: RecPriority;
  quality: RecQuality;
  marginPre: number;
  marginPost: number;
  keepRaw: boolean;
  encodePreset: PresetName;
}

export const REC_DEFAULTS_FALLBACK: RecDefaults = {
  priority: 'medium',
  quality: '1080i',
  marginPre: 0,
  marginPost: 30,
  keepRaw: false,
  encodePreset: 'h265-1080p',
};

// Key names in system_settings.
const K_PRIORITY     = 'rec.priority';
const K_QUALITY      = 'rec.quality';
const K_MARGIN_PRE   = 'rec.marginPre';
const K_MARGIN_POST  = 'rec.marginPost';
const K_KEEP_RAW     = 'rec.keepRaw';
const K_ENCODE_PRE   = 'rec.encodePreset';
const K_TVDB_API_KEY = 'tvdb.apiKey';

export interface TvdbApiKeyStatus {
  /** 'db' when a key is saved, 'none' when the store is empty. */
  source: 'db' | 'none';
  /** Last 4 characters of the stored key for masked display. */
  last4: string | null;
}

/** Admin-settings snapshot returned by GET /admin/settings. Key body is never exposed. */
export interface AdminSettingsSnapshot {
  rec: RecDefaults;
  tvdb: { apiKey: TvdbApiKeyStatus };
}

export interface AdminSettingsPatch {
  rec?: Partial<RecDefaults>;
  tvdb?: {
    /** Raw key. Pass '' to clear the saved key. */
    apiKey?: string;
  };
}

// -----------------------------------------------------------------
// Read side
// -----------------------------------------------------------------

export async function getRecDefaults(): Promise<RecDefaults> {
  const [priority, quality, marginPre, marginPost, keepRaw, encodePreset] = await Promise.all([
    getSetting<RecPriority>(K_PRIORITY),
    getSetting<RecQuality>(K_QUALITY),
    getSetting<number>(K_MARGIN_PRE),
    getSetting<number>(K_MARGIN_POST),
    getSetting<boolean>(K_KEEP_RAW),
    getSetting<PresetName>(K_ENCODE_PRE),
  ]);
  return {
    priority:     priority     ?? REC_DEFAULTS_FALLBACK.priority,
    quality:      quality      ?? REC_DEFAULTS_FALLBACK.quality,
    marginPre:    marginPre    ?? REC_DEFAULTS_FALLBACK.marginPre,
    marginPost:   marginPost   ?? REC_DEFAULTS_FALLBACK.marginPost,
    keepRaw:      keepRaw      ?? REC_DEFAULTS_FALLBACK.keepRaw,
    encodePreset: encodePreset ?? REC_DEFAULTS_FALLBACK.encodePreset,
  };
}

/** Return the raw TVDB API key, or null if unset. Used by tvdbService only. */
export async function getTvdbApiKey(): Promise<string | null> {
  const v = await getSetting<string>(K_TVDB_API_KEY);
  return v && v.length > 0 ? v : null;
}

export async function getTvdbApiKeyStatus(): Promise<TvdbApiKeyStatus> {
  const key = await getTvdbApiKey();
  if (!key) return { source: 'none', last4: null };
  return { source: 'db', last4: key.slice(-4) };
}

export async function getSnapshot(): Promise<AdminSettingsSnapshot> {
  const [rec, apiKey] = await Promise.all([getRecDefaults(), getTvdbApiKeyStatus()]);
  return { rec, tvdb: { apiKey } };
}

// -----------------------------------------------------------------
// Write side
// -----------------------------------------------------------------

const tvdbKeyListeners: Array<() => void> = [];

/** Subscribe to tvdb.apiKey changes. Fires on every PATCH that includes the key. */
export function onTvdbApiKeyChange(cb: () => void): () => void {
  tvdbKeyListeners.push(cb);
  return () => {
    const i = tvdbKeyListeners.indexOf(cb);
    if (i >= 0) tvdbKeyListeners.splice(i, 1);
  };
}

export async function patchSettings(patch: AdminSettingsPatch): Promise<AdminSettingsSnapshot> {
  if (patch.rec) {
    const { priority, quality, marginPre, marginPost, keepRaw, encodePreset } = patch.rec;
    if (priority     !== undefined) await upsertSetting(K_PRIORITY,    priority);
    if (quality      !== undefined) await upsertSetting(K_QUALITY,     quality);
    if (marginPre    !== undefined) await upsertSetting(K_MARGIN_PRE,  marginPre);
    if (marginPost   !== undefined) await upsertSetting(K_MARGIN_POST, marginPost);
    if (keepRaw      !== undefined) await upsertSetting(K_KEEP_RAW,    keepRaw);
    if (encodePreset !== undefined) await upsertSetting(K_ENCODE_PRE,  encodePreset);
  }
  if (patch.tvdb && patch.tvdb.apiKey !== undefined) {
    const v = patch.tvdb.apiKey;
    if (v === '') {
      await deleteSetting(K_TVDB_API_KEY);
    } else {
      await upsertSetting(K_TVDB_API_KEY, v);
    }
    for (const cb of tvdbKeyListeners) {
      try { cb(); } catch { /* swallow — one listener's bug must not block others */ }
    }
  }
  return getSnapshot();
}

// -----------------------------------------------------------------
// Low-level helpers (mirror gpuProbeService.ts to keep one idiom).
// -----------------------------------------------------------------

async function getSetting<T>(key: string): Promise<T | undefined> {
  const { db, systemSettings } = await dbHandles();
  const rows = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key));
  if (rows.length === 0) return undefined;
  return rows[0].value as T;
}

async function upsertSetting(key: string, value: unknown): Promise<void> {
  const { db, systemSettings } = await dbHandles();
  const jsonbVal = value === null ? sql`'null'::jsonb` : (value as never);
  await db
    .insert(systemSettings)
    .values({ key, value: jsonbVal, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: jsonbVal, updatedAt: new Date() },
    });
}

async function deleteSetting(key: string): Promise<void> {
  const { db, systemSettings } = await dbHandles();
  await db.delete(systemSettings).where(eq(systemSettings.key, key));
}
