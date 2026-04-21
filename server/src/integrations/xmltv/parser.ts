// XMLTV parser — consumes the standard XMLTV feed format (XMLTV DTD:
// https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd) and yields a
// simple set of parsed channels + programmes that callers can correlate
// against existing channel rows by `tvg-id`.
//
// We intentionally stay schema-agnostic of our `programs` table here —
// the caller (`channelSyncService`) decides how to stitch parsed entries
// to existing channels and feed them into `programService.upsertMany`.

import { XMLParser } from 'fast-xml-parser';

export interface XmltvChannel {
  /** XMLTV `<channel id="...">`. Matches m3u's `tvg-id` attribute. */
  id: string;
  /** First `<display-name>`. Optional; falls back to id. */
  displayName: string;
}

export interface XmltvProgramme {
  /** XMLTV `<programme channel="...">` — the channel id to correlate. */
  channelId: string;
  /** ISO-8601 with offset, e.g. "2026-04-21T06:30:00+09:00". */
  startAt: string;
  endAt: string;
  title: string;
  /** First `<desc>`, if present. */
  desc: string | null;
  /** `<sub-title>` — episode / subtitle; Plex often fills this for guide data. */
  subTitle: string | null;
  /** `<category>` list, raw. */
  categories: string[];
}

export interface XmltvParseResult {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
}

// Translate XMLTV's wall-clock format "YYYYMMDDHHMMSS ±HHMM" (with optional
// seconds, optional offset) into ISO-8601. XMLTV spec allows variable
// precision; we need at least the minute. Missing offset → assume UTC
// which is the XMLTV default per spec.
export function xmltvTimeToIso(raw: string): string {
  const s = raw.trim();
  // Match: date portion (required, ≥ 12 digits to include minutes) +
  // optional seconds + optional offset.
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(s);
  if (!m) {
    throw new Error(`invalid XMLTV time: ${raw}`);
  }
  const [, y, mo, d, hh, mm, ss, off] = m;
  const offset = off ? `${off.slice(0, 3)}:${off.slice(3)}` : '+00:00';
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss ?? '00'}${offset}`;
}

// fast-xml-parser returns either a single object or an array depending on
// cardinality. This coerces to an array for uniform iteration.
function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// Extract the first plain-text value from XMLTV text fields, which may
// appear as a string, an object with text + lang attributes, or an array
// of such. We don't care about language — pick the first.
function firstText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return firstText(v[0]);
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    if ('#text' in obj) return firstText(obj['#text']);
    // Some feeds put content under the tag name itself — no-op, return null.
  }
  return null;
}

export function parseXmltv(xml: string): XmltvParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Don't auto-parse numeric-looking strings; we handle timestamps ourselves
    // and channel ids like "1" must stay strings.
    parseAttributeValue: false,
    parseTagValue: false,
    // Programme bodies can repeat <category> and <desc>; we coerce to array
    // on our side via toArray() rather than forcing always-array globally.
    trimValues: true,
  });

  const doc = parser.parse(xml);
  const tv = doc?.tv;
  if (!tv || typeof tv !== 'object') {
    return { channels: [], programmes: [] };
  }

  const channels: XmltvChannel[] = toArray(tv.channel).map((c: Record<string, unknown>) => {
    const id = String(c['@_id'] ?? '').trim();
    const displayName = firstText(c['display-name']) ?? id;
    return { id, displayName };
  }).filter((c) => c.id.length > 0);

  const programmes: XmltvProgramme[] = [];
  for (const p of toArray(tv.programme) as Record<string, unknown>[]) {
    const channelId = String(p['@_channel'] ?? '').trim();
    const rawStart = String(p['@_start'] ?? '');
    const rawStop = String(p['@_stop'] ?? '');
    if (!channelId || !rawStart || !rawStop) continue;

    let startAt: string;
    let endAt: string;
    try {
      startAt = xmltvTimeToIso(rawStart);
      endAt = xmltvTimeToIso(rawStop);
    } catch {
      continue;
    }

    const title = firstText(p.title) ?? '';
    if (!title) continue;

    const desc = firstText(p.desc);
    const subTitle = firstText(p['sub-title']);
    const categories = toArray(p.category)
      .map((c) => firstText(c))
      .filter((c): c is string => !!c);

    programmes.push({ channelId, startAt, endAt, title, desc, subTitle, categories });
  }

  return { channels, programmes };
}
