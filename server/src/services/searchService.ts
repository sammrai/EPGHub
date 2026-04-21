import { asc, desc, eq, or, sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { Program } from '../schemas/program.ts';
import type { Rule } from '../schemas/rule.ts';
import type { Recording } from '../schemas/recording.ts';
import type { Channel } from '../schemas/channel.ts';
import type { TvdbEntry } from '../schemas/tvdb.ts';
import type { SearchResult } from '../schemas/search.ts';
import { db } from '../db/client.ts';
import { programs, rules, recordings, tvdbEntries } from '../db/schema.ts';
import { genreFromKey } from '../lib/genreRegistry.ts';
import { kanaFold, kanaFoldSql } from '../lib/textFold.ts';
import { tvdbRowToEntry } from './ruleService.ts';
import { channelService } from './channelService.ts';

// GitHub の検索モーダル風のグローバル検索。UI は結果をセクション毎に並べるだけ
// なので、サーバ側でそれぞれソート + 件数上限を適用して返す。
//
// - 各テーブルに独立した ILIKE 問い合わせを投げる。SQL の UNION を避け、
//   セクション別に適した order by / limit を個別に書けるようにしてある。
// - 番組は「未来のものを優先、次点で新しい過去」で昇順ソート。録画は作成新しい順。
// - channel と tvdb はインメモリで部分一致フィルタ (行数が小さく実害がない)。

const DEFAULT_LIMIT = 8;

// ILIKE 用のパターンにユーザ入力をそのまま渡すと % や _ がメタ文字扱いになる。
// 検索 UX の観点で「ワイルドカード指定」を期待するユーザはいないので、
// 全て literal に落とす。空白は個別の単語扱いではなく連結文字列として扱う
// (GitHub の検索モーダルもこの挙動)。
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface SearchOptions {
  q: string;
  limit?: number;
}

export interface SearchService {
  search(opts: SearchOptions): Promise<SearchResult>;
}

class DrizzleSearchService implements SearchService {
  async search({ q, limit }: SearchOptions): Promise<SearchResult> {
    const query = q.trim();
    const cap = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, 25));
    const empty: SearchResult = {
      q: query,
      total: 0,
      programs: [],
      series: [],
      channels: [],
      rules: [],
      recordings: [],
    };
    if (query.length === 0) return empty;

    // ひらがな / カタカナ / 全角英数 を一律カタカナ + 半角 ASCII に寄せてから
    // ILIKE で部分一致する。これで「どらま」⇔「ドラマ」「ＮＨＫ」⇔「NHK」が
    // 曖昧にヒットする。ILIKE なので大文字小文字はさらに無視される。
    const folded = kanaFold(query);
    const pat = `%${escapeLike(folded)}%`;
    const col = (c: SQLWrapper | SQL) => sql`${kanaFoldSql(c)} ILIKE ${pat}`;

    const [progsRows, rulesRows, recsRows, tvdbRows, channelsAll] = await Promise.all([
      // 番組: タイトル / 概要 / series key。未来 → 直近過去の順。
      db
        .select({ p: programs, t: tvdbEntries })
        .from(programs)
        .leftJoin(tvdbEntries, eq(programs.tvdbId, tvdbEntries.tvdbId))
        .where(
          or(
            col(programs.title),
            col(programs.desc),
            col(programs.series),
            col(sql`${programs.extended}::text`),
          ),
        )
        .orderBy(
          // CASE で「未来の番組を 0、過去を 1」に振って優先させ、その中で時刻昇順。
          sql`CASE WHEN ${programs.startAt} >= NOW() THEN 0 ELSE 1 END ASC`,
          asc(programs.startAt),
        )
        .limit(cap),

      db
        .select()
        .from(rules)
        .where(or(col(rules.name), col(rules.keyword)))
        .orderBy(desc(rules.enabled), asc(rules.id))
        .limit(cap),

      db
        .select()
        .from(recordings)
        .where(col(recordings.title))
        .orderBy(desc(recordings.startAt))
        .limit(cap),

      db
        .select()
        .from(tvdbEntries)
        .where(
          or(col(tvdbEntries.title), col(tvdbEntries.titleEn), col(tvdbEntries.slug)),
        )
        .limit(cap),

      channelService.list(),
    ]);

    const foldedLower = folded.toLowerCase();
    const channelsHit: Channel[] = channelsAll
      .filter((c) =>
        [c.name, c.short, c.id, c.number].some((s) =>
          kanaFold(s ?? '').toLowerCase().includes(foldedLower),
        ),
      )
      .slice(0, cap);

    const progsOut: Program[] = progsRows.map((row) => {
      const p: Program = {
        id: row.p.id,
        ch: row.p.ch,
        startAt: row.p.startAt.toISOString(),
        endAt: row.p.endAt.toISOString(),
        title: row.p.title,
        genre: genreFromKey(row.p.genreKey),
        ep: row.p.ep,
        series: row.p.series,
        hd: row.p.hd,
      };
      if (row.p.desc != null) p.desc = row.p.desc;
      if (row.p.extended != null && Object.keys(row.p.extended).length > 0) {
        p.extended = row.p.extended;
      }
      if (row.p.video != null) p.video = row.p.video;
      if (row.t) p.tvdb = tvdbRowToEntry(row.t);
      if (row.p.tvdbSeason != null) p.tvdbSeason = row.p.tvdbSeason;
      if (row.p.tvdbEpisode != null) p.tvdbEpisode = row.p.tvdbEpisode;
      if (row.p.tvdbEpisodeName != null) p.tvdbEpisodeName = row.p.tvdbEpisodeName;
      return p;
    });

    const seriesOut: TvdbEntry[] = tvdbRows.map(tvdbRowToEntry);

    const rulesOut: Rule[] = rulesRows.map((row) => ({
      id: row.id,
      name: row.name,
      keyword: row.keyword,
      channels: row.channels,
      enabled: row.enabled,
      matches: row.matches,
      nextMatch:
        row.nextMatchCh && row.nextMatchTitle && row.nextMatchAt
          ? {
              ch: row.nextMatchCh,
              title: row.nextMatchTitle,
              at: row.nextMatchAt.toISOString(),
            }
          : null,
      priority: row.priority as Rule['priority'],
      quality: row.quality as Rule['quality'],
      skipReruns: row.skipReruns,
      kind: row.kind as Rule['kind'],
      ngKeywords: row.ngKeywords ?? [],
      genreDeny: row.genreDeny ?? [],
      timeRangeDeny: row.timeRangeDeny ?? [],
    }));

    const recsOut: Recording[] = recsRows.map((row) => {
      const source: Recording['source'] =
        row.sourceKind === 'rule'
          ? { kind: 'rule', ruleId: row.sourceRuleId ?? 0 }
          : row.sourceKind === 'series'
            ? { kind: 'series', tvdbId: row.sourceTvdbId ?? 0 }
            : { kind: 'once' };
      const out: Recording = {
        id: row.id,
        programId: row.programId,
        ch: row.ch,
        title: row.title,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        priority: row.priority as Recording['priority'],
        quality: row.quality as Recording['quality'],
        keepRaw: row.keepRaw,
        marginPre: row.marginPre,
        marginPost: row.marginPost,
        source,
        state: row.state as Recording['state'],
      };
      if (row.allocatedTunerIdx != null) out.allocatedTunerIdx = row.allocatedTunerIdx;
      if (row.filename != null) out.filename = row.filename;
      if (row.thumb != null) out.thumb = row.thumb;
      if (row.size != null) out.size = row.size;
      if (row.duration != null) out.duration = row.duration;
      if (row.tvdbId != null) out.tvdbId = row.tvdbId;
      if (row.series != null) out.series = row.series;
      if (row.season != null) out.season = row.season;
      if (row.ep != null) out.ep = row.ep;
      if (row.epTitle != null) out.epTitle = row.epTitle;
      return out;
    });

    const total =
      progsOut.length +
      seriesOut.length +
      channelsHit.length +
      rulesOut.length +
      recsOut.length;

    return {
      q: query,
      total,
      programs: progsOut,
      series: seriesOut,
      channels: channelsHit,
      rules: rulesOut,
      recordings: recsOut,
    };
  }
}

export const searchService: SearchService = new DrizzleSearchService();
