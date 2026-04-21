import { z } from '@hono/zod-openapi';
import { ProgramSchema } from './program.ts';
import { TvdbEntrySchema } from './tvdb.ts';
import { ChannelSchema } from './channel.ts';
import { RuleSchema } from './rule.ts';
import { RecordingSchema } from './recording.ts';

// グローバル横断検索のレスポンス。GitHub の検索モーダルに着想を得た「セクション分け
// 形式」で、UI は各セクションをそのまま並べて表示するだけで済むようにしてある。
// サーバ側でそれぞれ上限件数に絞って返すので、クライアントは全量を抱え込まない。
export const SearchResultSchema = z
  .object({
    q: z.string().openapi({ description: '検索クエリ (正規化済み)' }),
    total: z.number().int().openapi({ description: '全セクション合算ヒット件数' }),
    programs: z.array(ProgramSchema).openapi({
      description: 'タイトル/説明/出演者 (extended) に一致する番組。未来寄りに並ぶ',
    }),
    series: z.array(TvdbEntrySchema).openapi({
      description: 'TVDB シリーズ/映画カタログに一致するエントリ',
    }),
    channels: z.array(ChannelSchema).openapi({
      description: '局名・略称・物理番号に一致するチャンネル',
    }),
    rules: z.array(RuleSchema).openapi({
      description: 'ルール名/キーワードに一致する自動予約ルール',
    }),
    recordings: z.array(RecordingSchema).openapi({
      description: '録画済み/録画中のタイトルに一致する録画行',
    }),
  })
  .openapi('SearchResult');

export type SearchResult = z.infer<typeof SearchResultSchema>;
