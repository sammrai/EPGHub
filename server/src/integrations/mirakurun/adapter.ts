import type { Channel } from '../../schemas/channel.ts';
import type { Program } from '../../schemas/program.ts';
import type { Genre } from '../../schemas/genre.ts';
import type { MrProgram, MrService } from './types.ts';

// ARIB service_type for "digital TV service" — the main HD broadcast.
// Other values cover 1seg mobile, data broadcasts, promotional channels etc.
// Reference: ARIB TR-B15 Annex 3-2.
const SERVICE_TYPE_DIGITAL_TV = 1;

const BC_TYPE_ORDER: Record<string, number> = { GR: 0, BS: 1, CS: 2, SKY: 3 };

/**
 * ISDB broadcasts multiple services per physical channel (main HD, sub-
 * channel for simulcast splits, 1seg mobile, datacast…). Mirakurun returns
 * all of them. For our listing we only want one row per broadcaster, so:
 *
 *   1. Drop services whose ARIB service_type isn't "digital TV" when known
 *      (when `type` is undefined we keep it to stay compatible with older
 *      Mirakurun builds).
 *   2. Group by `remoteControlKeyId` for GR (which is unique per station),
 *      falling back to `{bcType, channel.channel}` for BS/CS where the
 *      remote key id isn't populated.
 *   3. Within a group, keep the lowest `serviceId` — conventionally the
 *      primary HD service.
 */
export function dedupeServices(services: MrService[]): MrService[] {
  const groups = new Map<string, MrService>();
  for (const s of services) {
    if (s.channel.type === 'SKY') continue;
    if (s.type != null && s.type !== SERVICE_TYPE_DIGITAL_TV) continue;
    if (!s.name) continue;
    const key =
      s.remoteControlKeyId != null
        ? `rck:${s.channel.type}:${s.remoteControlKeyId}`
        : `ch:${s.channel.type}:${s.channel.channel}`;
    const prev = groups.get(key);
    if (!prev || s.serviceId < prev.serviceId) groups.set(key, s);
  }
  return Array.from(groups.values()).sort((a, b) => {
    const ta = BC_TYPE_ORDER[a.channel.type] ?? 99;
    const tb = BC_TYPE_ORDER[b.channel.type] ?? 99;
    if (ta !== tb) return ta - tb;
    const ra = a.remoteControlKeyId ?? (Number(a.channel.channel) || 9999);
    const rb = b.remoteControlKeyId ?? (Number(b.channel.channel) || 9999);
    return ra - rb;
  });
}

// ARIB spec: content_nibble_level_1 → genre label. Source: Mirakurun docs.
const ARIB_GENRES: Record<number, Genre> = {
  0x0: { key: 'news',  label: 'ニュース',      dot: 'oklch(0.6 0.02 250)' },
  0x1: { key: 'sport', label: 'スポーツ',       dot: 'oklch(0.6 0.14 150)' },
  0x2: { key: 'info',  label: '情報',           dot: 'oklch(0.68 0.1 100)' },
  0x3: { key: 'drama', label: 'ドラマ',         dot: 'oklch(0.62 0.12 20)' },
  0x4: { key: 'music', label: '音楽',           dot: 'oklch(0.62 0.12 340)' },
  0x5: { key: 'var',   label: 'バラエティ',     dot: 'oklch(0.7 0.13 80)' },
  0x6: { key: 'movie', label: '映画',           dot: 'oklch(0.5 0.1 40)' },
  0x7: { key: 'anime', label: 'アニメ',         dot: 'oklch(0.65 0.14 300)' },
  0x8: { key: 'doc',   label: 'ドキュメンタリー', dot: 'oklch(0.55 0.08 200)' },
  0x9: { key: 'doc',   label: '劇場',           dot: 'oklch(0.55 0.08 200)' },
  0xA: { key: 'edu',   label: '教育',           dot: 'oklch(0.6 0.09 160)' },
  0xB: { key: 'edu',   label: '福祉',           dot: 'oklch(0.6 0.09 160)' },
};
const UNKNOWN_GENRE: Genre = { key: 'info', label: 'その他', dot: 'oklch(0.68 0.1 100)' };

const HUE_PALETTE = [28, 140, 30, 250, 260, 150, 280, 200, 220, 300, 0, 340];

export function serviceToChannel(svc: MrService): Channel {
  const type = svc.channel.type;
  if (type === 'SKY') {
    // epghub doesn't expose SKY PerfecTV tuners in the UI; filter callers.
  }
  const normalizedType = type === 'SKY' ? 'CS' : type;
  const hue = HUE_PALETTE[svc.serviceId % HUE_PALETTE.length];
  return {
    id: `svc-${svc.id}`,
    name: svc.name,
    short: svc.name.slice(0, 6),
    number: svc.remoteControlKeyId != null ? String(svc.remoteControlKeyId).padStart(3, '0') : svc.channel.channel,
    type: normalizedType,
    color: `oklch(0.58 0.11 ${hue})`,
    enabled: true,
    source: 'mirakurun',
  };
}

export function programToProgram(
  p: MrProgram,
  channelsById: Map<number, Channel>
): Program | null {
  const ch = channelsById.get(p.serviceId);
  if (!ch) return null;
  const startAt = new Date(p.startAt).toISOString();
  const endAt = new Date(p.startAt + p.duration).toISOString();
  const genre = p.genres && p.genres.length > 0 ? ARIB_GENRES[p.genres[0].lv1] ?? UNKNOWN_GENRE : UNKNOWN_GENRE;
  const id = `${ch.id}_${startAt}`;
  const hd = p.video?.resolution?.startsWith('1080') ?? false;
  const result: Program = {
    id,
    ch: ch.id,
    startAt,
    endAt,
    title: p.name ?? '(無題)',
    genre,
    ep: null,
    series: null,
    hd,
  };
  if (p.description) result.desc = p.description;
  if (p.extended && Object.keys(p.extended).length > 0) result.extended = p.extended;
  if (p.video?.resolution) result.video = p.video.resolution;
  return result;
}
