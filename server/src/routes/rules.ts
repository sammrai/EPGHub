import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import {
  CreateRuleSchema,
  RuleListSchema,
  RuleSchema,
  UpdateRuleSchema,
} from '../schemas/rule.ts';
import { ProgramSchema } from '../schemas/program.ts';
import { ErrorSchema } from '../schemas/common.ts';
import { ruleService, RuleConflictError } from '../services/ruleService.ts';
import { expandRules, rulePredicate } from '../services/ruleExpander.ts';
import { programService } from '../services/programService.ts';

export const rulesRouter = new OpenAPIHono();

const list = createRoute({
  method: 'get',
  path: '/rules',
  tags: ['rules'],
  summary: '録画ルール一覧',
  responses: {
    200: { description: 'ルール配列', content: { 'application/json': { schema: RuleListSchema } } },
  },
});

const create = createRoute({
  method: 'post',
  path: '/rules',
  tags: ['rules'],
  summary: 'ルール作成',
  description:
    '同じ TVDB id に対する series ルールはすでに存在する場合 409 を返す。',
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateRuleSchema } } },
  },
  responses: {
    201: { description: 'ルール作成', content: { 'application/json': { schema: RuleSchema } } },
    409: { description: '重複 (同 TVDB の series rule が既存)', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

const IdParam = z.object({
  id: z.coerce.number().int().openapi({ param: { in: 'path' }, example: 1 }),
});

const ExpandSummarySchema = z
  .object({
    matchedPrograms: z.number().int(),
    createdRecordings: z.number().int(),
    conflicts: z.object({
      duplicate: z.number().int(),
      tunerFull: z.number().int(),
    }),
  })
  .openapi('RuleExpandSummary');

const expand = createRoute({
  method: 'get',
  path: '/rules/expand',
  tags: ['rules'],
  summary: 'ルールを即時展開 (非推奨)',
  deprecated: true,
  description:
    '非推奨。副作用を伴う操作には POST /admin/expand-rules を使用してください。'
    + 'GET のまま残してあるのは既存ジョブ/ブックマークとの互換のため。',
  responses: {
    200: {
      description: '展開サマリ',
      content: { 'application/json': { schema: ExpandSummarySchema } },
    },
  },
});

const update = createRoute({
  method: 'patch',
  path: '/rules/{id}',
  tags: ['rules'],
  summary: 'ルール更新 (有効化/無効化・属性変更)',
  request: {
    params: IdParam,
    body: { required: true, content: { 'application/json': { schema: UpdateRuleSchema } } },
  },
  responses: {
    200: { description: '更新後のルール', content: { 'application/json': { schema: RuleSchema } } },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

const remove = createRoute({
  method: 'delete',
  path: '/rules/{id}',
  tags: ['rules'],
  summary: 'ルール削除',
  request: { params: IdParam },
  responses: {
    204: { description: '削除成功' },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

const RULE_MATCHES_HORIZON_DAYS = 14;
const RULE_MATCHES_MAX = 50;

const RuleMatchesResponse = z.object({
  matches: z.array(ProgramSchema).openapi({
    description:
      `当該ルールが向こう${RULE_MATCHES_HORIZON_DAYS}日間に拾う番組 ` +
      `(最大 ${RULE_MATCHES_MAX} 件)。rulePredicate で ngKeywords/skipReruns/` +
      'チャンネル制限まで反映する。GuidePanel の「ルール解除」ボタン横▼で ' +
      'プレビューに使う。',
  }),
});

const matches = createRoute({
  method: 'get',
  path: '/rules/{id}/matches',
  tags: ['rules'],
  summary: 'ルールが拾う番組',
  description:
    'このルールが向こう14日間にマッチする予定の番組を返す。実際の予約を ' +
    '作る前後どちらでも同じ結果になるよう ruleExpander の rulePredicate を ' +
    '直接使うので、recordings 表に出ているかどうかとは独立。',
  request: { params: IdParam },
  responses: {
    200: { description: 'マッチ番組一覧', content: { 'application/json': { schema: RuleMatchesResponse } } },
    404: { description: '見つからない', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

rulesRouter.openapi(list, async (c) => c.json(await ruleService.list(), 200));

rulesRouter.openapi(expand, async (c) => {
  const summary = await expandRules();
  return c.json(summary, 200);
});

rulesRouter.openapi(create, async (c) => {
  const body = c.req.valid('json');
  try {
    const rule = await ruleService.create(body);
    // Expand the new rule against the loaded schedule synchronously so the
    // user sees the matching reserves appear without waiting for the
    // 10-minute cron tick. The expander is idempotent (it dedupes against
    // existing recordings + the recorded-history ledger), so running it
    // here on top of the cron is safe.
    if (rule.enabled) {
      try {
        await expandRules();
      } catch (e) {
        // The rule itself was created — surface the rule but log the
        // expansion failure so we don't leave the caller stuck.
        console.warn('[rules.create] post-create rule.expand failed:', (e as Error).message);
      }
    }
    return c.json(rule, 201);
  } catch (e) {
    if (e instanceof RuleConflictError) {
      return c.json(
        { code: `rule.${e.reason}`, message: '同じTVDBシリーズの録画ルールがすでにあります', detail: e.detail },
        409
      );
    }
    throw e;
  }
});

rulesRouter.openapi(update, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  // Snapshot the BEFORE state so we can detect an enabled false→true
  // transition and re-expand. ruleService.update already handles the
  // true→false cleanup (cascade-deletes scheduled reserves) on its end.
  const before = await ruleService.findById(id);
  const next = await ruleService.update(id, body);
  if (!next) {
    return c.json({ code: 'rule.not_found', message: 'ルールが見つかりません' }, 404);
  }
  // On re-enable, kick the expander synchronously — same pattern as the
  // create handler. Without this the user would see "ON" in the UI but
  // no reserves until the 10-minute cron tick.
  if (before && !before.enabled && next.enabled) {
    try {
      await expandRules();
    } catch (e) {
      console.warn('[rules.update] post-enable rule.expand failed:', (e as Error).message);
    }
  }
  return c.json(next, 200);
});

rulesRouter.openapi(remove, async (c) => {
  const { id } = c.req.valid('param');
  const ok = await ruleService.remove(id);
  if (!ok) {
    return c.json({ code: 'rule.not_found', message: 'ルールが見つかりません' }, 404);
  }
  return c.body(null, 204);
});

rulesRouter.openapi(matches, async (c) => {
  const { id } = c.req.valid('param');
  const rule = await ruleService.findById(id);
  if (!rule) {
    return c.json({ code: 'rule.not_found', message: 'ルールが見つかりません' }, 404);
  }
  const now = Date.now();
  const horizonMs = now + RULE_MATCHES_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const upcoming = await programService.listInRange(now, horizonMs);
  const hits: typeof upcoming = [];
  for (const p of upcoming) {
    if (rulePredicate(rule, p, now)) {
      hits.push(p);
      if (hits.length >= RULE_MATCHES_MAX) break;
    }
  }
  return c.json({ matches: hits }, 200);
});
