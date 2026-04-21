// -----------------------------------------------------------------
// Pure m3u8 / extended-m3u playlist parser. Format reference:
//
//   #EXTM3U
//   #EXTINF:-1 tvg-id="bs01" tvg-name="BS-TBS" tvg-logo="..." group-title="BS",BS-TBS
//   http://example.com/stream/bs-tbs
//
// Rules we enforce:
//   - Blank lines are ignored.
//   - Non-`#EXTINF:` comment lines (anything starting with `#`) are ignored.
//     This covers the `#EXTM3U` header, `#EXTVLCOPT:` options etc., which are
//     not used by channel sync today.
//   - A plain URL line is only collected when an `#EXTINF` line immediately
//     precedes it (we tolerate intervening comment / blank lines). Orphan URL
//     lines are silently dropped — some extractors emit them for legacy
//     EPGStation configs that we'd rather skip than mis-classify.
//   - Windows-style `\r\n` endings are stripped before processing.
//   - The `#EXTM3U` header is not required. A naked EXTINF+URL pair still
//     parses — some user-supplied snippets drop the header when copy-pasting.
// -----------------------------------------------------------------

export interface M3uEntry {
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  groupTitle?: string;
  channelNumber?: string;
  name: string;
  streamUrl: string;
}

const ATTR_MAP: Record<string, keyof M3uEntry> = {
  'tvg-id': 'tvgId',
  'tvg-name': 'tvgName',
  'tvg-logo': 'tvgLogo',
  'group-title': 'groupTitle',
  'tvg-chno': 'channelNumber',
  'channel-number': 'channelNumber',
};

/**
 * Parse the attribute-list portion of an `#EXTINF:-1 …` line. The attribute
 * list sits between the duration (`-1`/`0` after the colon) and the first
 * unquoted comma — the display name follows that comma. We treat each
 * `key="value"` (or `key=value`) pair as a discrete attribute.
 */
function parseAttributes(attrs: string): Partial<M3uEntry> {
  const out: Partial<M3uEntry> = {};
  // Match either key="value" or key=unquoted-token. The value capture group
  // for the quoted form grabs text between the nearest matching pair of
  // double quotes; the unquoted form stops at whitespace.
  const re = /([\w-]+)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) != null) {
    const key = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? '';
    const mapped = ATTR_MAP[key];
    if (mapped) {
      (out as Record<string, string>)[mapped] = value;
    }
  }
  return out;
}

/**
 * Parse a single `#EXTINF:` line into its attribute bag + display name. The
 * duration token (`-1`, `0`, or a positive integer) is discarded — we don't
 * use it in channel registration.
 */
function parseExtinf(line: string): { attrs: Partial<M3uEntry>; name: string } | null {
  // Strip the leading `#EXTINF:`. Anything else is not our problem.
  const body = line.slice('#EXTINF:'.length);
  // Find the first comma that isn't inside a quoted value. Easier to walk
  // char-by-char than build a regex with the right lookbehind semantics.
  let inQuote = false;
  let commaIdx = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && !inQuote) {
      commaIdx = i;
      break;
    }
  }
  if (commaIdx < 0) {
    // `#EXTINF:-1` with no name is tolerated — yields empty name. Only used
    // so pipeline doesn't error on minimal playlists; caller will still
    // discard entries whose streamUrl is missing.
    return { attrs: {}, name: '' };
  }
  // `head` is "<duration> <attr1=…> <attr2=…>"; `name` is the trailing label.
  const head = body.slice(0, commaIdx);
  const name = body.slice(commaIdx + 1).trim();
  // Drop the duration token (first whitespace-delimited piece). What's left
  // is the attribute list — empty string when the line has no attrs.
  const afterDuration = head.replace(/^\s*-?\d+(\.\d+)?\s*/, '');
  return { attrs: parseAttributes(afterDuration), name };
}

export function parseM3u(text: string): M3uEntry[] {
  const out: M3uEntry[] = [];
  // Normalize line endings so split('\n') covers CRLF + LF + CR inputs.
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let pending: { attrs: Partial<M3uEntry>; name: string } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#EXTINF:')) {
      pending = parseExtinf(line);
      continue;
    }
    if (line.startsWith('#')) {
      // Non-EXTINF comment (header, EXTVLCOPT, etc.). Skip without clearing
      // `pending` — some playlists emit `#EXTVLCOPT:` between EXTINF and URL.
      continue;
    }
    if (pending) {
      const entry: M3uEntry = {
        name: pending.name,
        streamUrl: line,
        ...pending.attrs,
      };
      out.push(entry);
      pending = null;
    }
    // else: orphan URL line with no preceding EXTINF — drop silently.
  }
  return out;
}
