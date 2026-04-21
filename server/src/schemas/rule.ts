import { z } from '@hono/zod-openapi';
import { PrioritySchema, QualitySchema } from './recording.ts';
import { TvdbEntrySchema } from './tvdb.ts';

export const RuleKindSchema = z.enum(['keyword', 'series']).openapi('RuleKind');

export const RuleNextMatchSchema = z
  .object({
    ch: z.string(),
    title: z.string(),
    at: z.string().datetime({ offset: true }),
  })
  .openapi('RuleNextMatch');

// Time-of-day range (JST wall clock) — inclusive start, exclusive end.
// Ranges that wrap past midnight (e.g. 23:00–05:00) are supported — see
// ruleExpander's in-range check.
export const TimeRangeDenySchema = z
  .object({
    start: z.string().regex(/^\d{2}:\d{2}$/).openapi({ example: '02:00' }),
    end:   z.string().regex(/^\d{2}:\d{2}$/).openapi({ example: '05:00' }),
  })
  .openapi('TimeRangeDeny');

export const RuleSchema = z
  .object({
    id: z.number().int().openapi({ example: 1 }),
    name: z.string().openapi({ example: '大河ドラマ 風の群像' }),
    keyword: z.string(),
    channels: z.array(z.string()).openapi({ description: '対象チャンネル id' }),
    enabled: z.boolean(),
    matches: z.number().int().openapi({ description: 'これまでの一致件数 (累計)' }),
    nextMatch: RuleNextMatchSchema.nullable(),
    priority: PrioritySchema,
    quality: QualitySchema,
    skipReruns: z.boolean(),
    kind: RuleKindSchema,
    tvdb: TvdbEntrySchema.optional(),
    // Exclusion predicates — all additive. A rule is matched only when
    // every deny-list fails to match.
    ngKeywords: z.array(z.string()).default([]).openapi({
      description: 'タイトルにこれらのキーワードが含まれる番組は除外 (傑作選・総集編など)',
      example: ['傑作選', '総集編'],
    }),
    genreDeny: z.array(z.string()).default([]).openapi({
      description: '番組ジャンル key (news/info/…) がここに含まれる番組は除外',
      example: ['news'],
    }),
    timeRangeDeny: z.array(TimeRangeDenySchema).default([]).openapi({
      description: '開始時刻 (JST) がいずれかのレンジ内に入る番組は除外',
    }),
  })
  .openapi('Rule');

export const RuleListSchema = z.array(RuleSchema).openapi('RuleList');

export const CreateRuleSchema = RuleSchema.omit({
  id: true,
  matches: true,
  nextMatch: true,
}).partial({
    kind: true,
    tvdb: true,
    skipReruns: true,
    priority: true,
    quality: true,
    channels: true,
    enabled: true,
    ngKeywords: true,
    genreDeny: true,
    timeRangeDeny: true,
  })
  .extend({
    name: z.string(),
    keyword: z.string(),
  })
  .openapi('CreateRule');

export const UpdateRuleSchema = CreateRuleSchema.partial().openapi('UpdateRule');

export type Rule = z.infer<typeof RuleSchema>;
