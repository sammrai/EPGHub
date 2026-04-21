// Plex-style filename builder — pure, side-effect free.
//
// Plex's library scanner expects a specific on-disk layout:
//   Shows/<Series>/Season <NN>/<Series> - sNNeNN - <EpName>.<ext>
//   Movies/<Title> (<Year>)/<Title> (<Year>).<ext>
// Anything else triggers "no match" in the Plex UI even when metadata exists.
// We build that layout at recorder stop-time so newly finished recordings
// drop into a Plex-ready tree under RECORDING_DIR.
//
// This module returns only the relative path (dir + filename). The caller
// prepends RECORDING_DIR and takes care of mkdir / rename / collision.

export interface PlexNameInput {
  /** Broadcast-level title — used as fallback when no tvdb metadata. */
  title: string;
  /** ISO-8601 start timestamp, used to build the JST date stamp. */
  startAtIso: string;
  /** Resolved TVDB entry (if any). */
  tvdb: { kind: 'series' | 'movie'; title: string; year?: number | null } | null;
  /** Season number — may be null for untagged series. 0 = specials. */
  season: number | null;
  /** Episode number — may be null even when season is known. */
  episode: number | null;
  /** Display-name of the episode from TVDB. */
  episodeName: string | null;
  /** Container extension (no leading dot). */
  extension: 'ts' | 'mp4' | 'm4a';
  /** Recording id — last 8 chars used as a collision salt for noisy cases. */
  recordingId: string;
}

export interface PlexNameResult {
  /** Relative directory path from RECORDING_DIR (no leading slash). */
  dir: string;
  /** Filename with extension. */
  filename: string;
  /** `${dir}/${filename}` — convenience for the caller. */
  relPath: string;
}

const MAX_COMPONENT = 100;

/**
 * Sanitize a string for use as a single path component.
 *
 * - Replaces path-unsafe chars (`/ \ : * ? " < > |`) and control chars with `_`.
 * - Strips trailing space/dot (Windows FS rejects these).
 * - Trims to 100 chars.
 */
export function sanitizeComponent(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    // Control chars (0x00-0x1F) and DEL (0x7F) → _
    if (code < 0x20 || code === 0x7f) {
      out += '_';
      continue;
    }
    if (ch === '/' || ch === '\\' || ch === ':' || ch === '*' ||
        ch === '?' || ch === '"' || ch === '<' || ch === '>' || ch === '|') {
      out += '_';
      continue;
    }
    out += ch;
  }
  // Trim to the max length first so trailing cleanup sees the truncated tail.
  if (out.length > MAX_COMPONENT) out = out.slice(0, MAX_COMPONENT);
  // Strip trailing space/dot (repeat until clean).
  while (out.length > 0 && (out.endsWith(' ') || out.endsWith('.'))) {
    out = out.slice(0, -1);
  }
  // Never return an empty component — Plex + FS both choke on it.
  if (out.length === 0) out = '_';
  return out;
}

/**
 * Zero-pad numbers to 2 digits. 3+ digits return raw (so s100e200 remains
 * readable rather than being truncated).
 */
export function zeroPad2(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '00';
  const s = String(Math.floor(n));
  return s.length >= 2 ? s : '0'.repeat(2 - s.length) + s;
}

/**
 * JST stamp for a given ISO string — `YYYYMMDD_HHMM`. Mirrors the flat-layout
 * recorder helper so filenames stay consistent across old/new recordings.
 */
function jstStamp(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}${mm}${dd}_${hh}${mi}`;
}

/**
 * Build the Plex-ready relative path for a recording.
 *
 * Branches:
 *   1. Movie (tvdb.kind=movie)       → Movies/<Title> (<Year>)/<Title> (<Year>).<ext>
 *   2. Series, S+E known             → Shows/<T>/Season NN/<T> - sNNeNN[ - <Name>].<ext>
 *   3. Series, S known, E null       → Shows/<T>/Season NN/<T> - sNN - <stamp>_<id8>.<ext>
 *   4. Series, S null                → Shows/<T>/Season 01/<T> - <stamp>_<id8>.<ext>
 *   5. No tvdb (unmatched broadcast) → Shows/<BT>/Season 01/<BT> - <stamp>_<id8>.<ext>
 *
 * Case #2 with an epName is the only branch that skips the `_<id8>` collision
 * salt — for well-tagged episodes we want clean Plex-recognizable filenames
 * and leave duplicate handling to the rename-side `_1`,`_2`... suffix logic.
 */
export function plexPath(input: PlexNameInput): PlexNameResult {
  const ext = input.extension;
  const id8 = input.recordingId.slice(-8);
  const stamp = jstStamp(input.startAtIso);

  // --- Movie branch -------------------------------------------------
  if (input.tvdb && input.tvdb.kind === 'movie') {
    const title = sanitizeComponent(input.tvdb.title);
    const year = input.tvdb.year ?? null;
    const base = year ? `${title} (${year})` : title;
    // The base here already contains only-safe chars (title was sanitized
    // and the `(YYYY)` suffix is ASCII digits). No re-sanitize needed.
    const dir = `Movies/${base}`;
    // Movies get the id8 salt too — home-recordings are rarely pristine
    // single-copies and two airings shouldn't silently fight.
    const filename = `${base}_${id8}.${ext}`;
    return { dir, filename, relPath: `${dir}/${filename}` };
  }

  // --- Series branches ----------------------------------------------
  // Prefer tvdb title when available (stable across EPG title drift),
  // otherwise fall back to the broadcast title.
  const rawTitle = input.tvdb?.title ?? input.title;
  const title = sanitizeComponent(rawTitle);

  // Season 00 = specials. A missing season defaults the directory to
  // Season 01 so the file still lands somewhere Plex will index.
  const seasonNum = input.season ?? 1;
  const seasonDir = `Season ${zeroPad2(seasonNum)}`;
  const dir = `Shows/${title}/${seasonDir}`;

  // Case #2 — full series tuple with both S and E known.
  if (input.season != null && input.episode != null) {
    const se = `s${zeroPad2(input.season)}e${zeroPad2(input.episode)}`;
    const epNamePart = input.episodeName
      ? ` - ${sanitizeComponent(input.episodeName)}`
      : '';
    // Clean case (has epName): no id8 suffix, rely on caller `_N` dedupe.
    // Noisy case (no epName): add id8 salt so two airings of the same
    // S/E (reruns tagged identically) land on different paths.
    if (input.episodeName) {
      const filename = `${title} - ${se}${epNamePart}.${ext}`;
      return { dir, filename, relPath: `${dir}/${filename}` };
    }
    const filename = `${title} - ${se}_${id8}.${ext}`;
    return { dir, filename, relPath: `${dir}/${filename}` };
  }

  // Case #3 — season known, episode unknown.
  if (input.season != null) {
    const filename = `${title} - s${zeroPad2(input.season)} - ${stamp}_${id8}.${ext}`;
    return { dir, filename, relPath: `${dir}/${filename}` };
  }

  // Cases #4 + #5 — no season info at all. Default to Season 01.
  // (Dir already computed above with seasonNum=1.)
  const filename = `${title} - ${stamp}_${id8}.${ext}`;
  return { dir, filename, relPath: `${dir}/${filename}` };
}
