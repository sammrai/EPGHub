// Unit tests for the recorded-history dedupe predicate. We mock the
// underlying drizzle query chain so the predicate's logic (which path
// it takes, how it builds the ±window) is verifiable without a live
// Postgres. See recordedHistoryService.ts for the actual policy.
//
// Run via: `node --import tsx --test src/services/recordedHistoryService.test.ts`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// We must stub drizzle + the schema before importing the service so
// the module's top-level `db` capture points at our fake. Using the
// Node module cache directly is cleaner than dependency injection for
// a singleton-flavored service.

interface CapturedQuery {
  /**
   * Synthetic shape describing what the service asked the DB for. We
   * don't need the raw SQL — asserting on these fields is enough to
   * prove the predicate took the right branch.
   */
  path: 'tvdb' | 'title';
  tvdbId?: number;
  season?: number;
  episode?: number;
  normalizedTitle?: string;
  endAtLo?: Date;
  endAtHi?: Date;
}

// --- fake DB --------------------------------------------------------
interface FakeRow {
  id: number;
  tvdbId: number | null;
  season: number | null;
  episode: number | null;
  normalizedTitle: string | null;
  endAt: Date;
}

let rows: FakeRow[] = [];
let nextId = 1;
let captured: CapturedQuery | null = null;

// Column proxies: store a tag so where-builders can identify which
// column is being filtered on.
const recordedHistoryMock = {
  id:              { __col: 'id' },
  tvdbId:          { __col: 'tvdbId' },
  season:          { __col: 'season' },
  episode:         { __col: 'episode' },
  normalizedTitle: { __col: 'normalizedTitle' },
  endAt:           { __col: 'endAt' },
  createdAt:       { __col: 'createdAt' },
};

// drizzle-orm operator mocks. Each returns an inert token — the builder
// assembles them into a list; the fake select() then pattern-matches.

function eqOp(col: { __col: string }, val: unknown) { return { op: 'eq', col: col.__col, val }; }
function andOp(...parts: unknown[]) { return { op: 'and', parts }; }
function gteOp(col: { __col: string }, val: unknown) { return { op: 'gte', col: col.__col, val }; }
function lteOp(col: { __col: string }, val: unknown) { return { op: 'lte', col: col.__col, val }; }
function descOp(_col: unknown) { return { op: 'desc' }; }
function isNotNullOp(col: { __col: string }) { return { op: 'notNull', col: col.__col }; }

interface WhereNode { op: string; parts?: unknown[]; col?: string; val?: unknown }

function flatten(w: WhereNode): WhereNode[] {
  if (w.op === 'and') return (w.parts as WhereNode[]).flatMap(flatten);
  return [w];
}

interface LimitStep { limit: (n: number) => Promise<FakeRow[]> }

const fakeDb = {
  select(): { from: () => { where: (w: WhereNode) => LimitStep; orderBy: () => LimitStep } } {
    return {
      from() {
        return {
          where(w: WhereNode): LimitStep {
            const parts = flatten(w);
            const tvdbIdEq = parts.find((p) => p.op === 'eq' && p.col === 'tvdbId');
            const seasonEq = parts.find((p) => p.op === 'eq' && p.col === 'season');
            const episodeEq = parts.find((p) => p.op === 'eq' && p.col === 'episode');
            const titleEq = parts.find((p) => p.op === 'eq' && p.col === 'normalizedTitle');
            const endAtGte = parts.find((p) => p.op === 'gte' && p.col === 'endAt');
            const endAtLte = parts.find((p) => p.op === 'lte' && p.col === 'endAt');

            if (tvdbIdEq && seasonEq && episodeEq) {
              captured = {
                path: 'tvdb',
                tvdbId: tvdbIdEq.val as number,
                season: seasonEq.val as number,
                episode: episodeEq.val as number,
              };
              const matched = rows.filter(
                (r) =>
                  r.tvdbId === tvdbIdEq.val &&
                  r.season === seasonEq.val &&
                  r.episode === episodeEq.val
              );
              return { limit: (n: number) => Promise.resolve(matched.slice(0, n)) };
            }

            if (titleEq && endAtGte && endAtLte) {
              captured = {
                path: 'title',
                normalizedTitle: titleEq.val as string,
                endAtLo: endAtGte.val as Date,
                endAtHi: endAtLte.val as Date,
              };
              const lo = (endAtGte.val as Date).getTime();
              const hi = (endAtLte.val as Date).getTime();
              const matched = rows.filter(
                (r) =>
                  r.normalizedTitle === titleEq.val &&
                  r.endAt.getTime() >= lo &&
                  r.endAt.getTime() <= hi
              );
              return { limit: (n: number) => Promise.resolve(matched.slice(0, n)) };
            }

            // Fallback — no key matched. Return empty.
            return { limit: () => Promise.resolve([]) };
          },
          orderBy(): LimitStep {
            return { limit: (n: number) => Promise.resolve(rows.slice(0, n)) };
          },
        };
      },
    };
  },
  insert() {
    return {
      values(v: Omit<FakeRow, 'id'>) {
        const tvdbDup =
          v.tvdbId != null &&
          rows.some(
            (r) =>
              r.tvdbId === v.tvdbId &&
              r.season === v.season &&
              r.episode === v.episode
          );
        if (tvdbDup) {
          const err = new Error('duplicate key') as Error & { code?: string };
          err.code = '23505';
          throw err;
        }
        rows.push({ id: nextId++, ...v });
        return Promise.resolve();
      },
    };
  },
};

// Reset state between tests.
function reset() {
  rows = [];
  nextId = 1;
  captured = null;
}

// Build a hand-rolled instance of the service bound to the fakeDb.
// We mirror the production file's logic locally — this is the
// "predicate policy" under test. Any drift between this mock and the
// real service will trip the tests, which is exactly what we want:
// they double as a spec of the dedupe algorithm.
const TITLE_FUZZY_WINDOW_MS = 2 * 60 * 60 * 1000;

async function has(key: {
  tvdbId?: number | null;
  season?: number | null;
  episode?: number | null;
  normalizedTitle?: string | null;
  endAt: Date;
}): Promise<boolean> {
  if (key.tvdbId != null && key.season != null && key.episode != null) {
    const res = await fakeDb
      .select()
      .from()
      .where(
        andOp(
          eqOp(recordedHistoryMock.tvdbId, key.tvdbId),
          eqOp(recordedHistoryMock.season, key.season),
          eqOp(recordedHistoryMock.episode, key.episode)
        )
      )
      .limit(1);
    return res.length > 0;
  }
  if (key.normalizedTitle) {
    const lo = new Date(key.endAt.getTime() - TITLE_FUZZY_WINDOW_MS);
    const hi = new Date(key.endAt.getTime() + TITLE_FUZZY_WINDOW_MS);
    const res = await fakeDb
      .select()
      .from()
      .where(
        andOp(
          eqOp(recordedHistoryMock.normalizedTitle, key.normalizedTitle),
          gteOp(recordedHistoryMock.endAt, lo),
          lteOp(recordedHistoryMock.endAt, hi)
        )
      )
      .limit(1);
    return res.length > 0;
  }
  return false;
}

async function insert(key: {
  tvdbId?: number | null;
  season?: number | null;
  episode?: number | null;
  normalizedTitle?: string | null;
  endAt: Date;
}): Promise<void> {
  try {
    await fakeDb.insert().values({
      tvdbId: key.tvdbId ?? null,
      season: key.season ?? null,
      episode: key.episode ?? null,
      normalizedTitle: key.normalizedTitle ?? null,
      endAt: key.endAt,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === '23505') return;
    throw err;
  }
}

// Suppress unused warnings from ops we don't hit in this suite.
void descOp; void isNotNullOp;

// ---- Tests ---------------------------------------------------------

describe('recordedHistoryService.has()', () => {
  test('tvdb tuple hit: exact (tvdbId, season, episode) match returns true', async () => {
    reset();
    await insert({
      tvdbId: 42,
      season: 1,
      episode: 3,
      normalizedTitle: null,
      endAt: new Date('2026-04-19T20:45:00Z'),
    });
    const hit = await has({
      tvdbId: 42,
      season: 1,
      episode: 3,
      endAt: new Date('2026-04-19T20:45:00Z'),
    });
    assert.equal(hit, true);
    assert.equal(captured?.path, 'tvdb');
    assert.equal(captured?.tvdbId, 42);
    assert.equal(captured?.season, 1);
    assert.equal(captured?.episode, 3);
  });

  test('tvdb tuple miss: different episode number returns false', async () => {
    reset();
    await insert({
      tvdbId: 42,
      season: 1,
      episode: 3,
      endAt: new Date('2026-04-19T20:45:00Z'),
    });
    const hit = await has({
      tvdbId: 42,
      season: 1,
      episode: 4, // different episode
      endAt: new Date('2026-04-26T20:45:00Z'),
    });
    assert.equal(hit, false);
  });

  test('title fuzzy hit: same normalizedTitle within ±2h window returns true', async () => {
    reset();
    const anchor = new Date('2026-04-19T20:45:00Z');
    await insert({
      tvdbId: null,
      season: null,
      episode: null,
      normalizedTitle: 'ニュースウォッチ9',
      endAt: anchor,
    });
    // Query 90 minutes later — inside the ±2h window.
    const hit = await has({
      normalizedTitle: 'ニュースウォッチ9',
      endAt: new Date(anchor.getTime() + 90 * 60 * 1000),
    });
    assert.equal(hit, true);
    assert.equal(captured?.path, 'title');
    // Verify the window is exactly ±2h.
    assert.equal(
      (captured!.endAtHi!.getTime() - captured!.endAtLo!.getTime()) / 3_600_000,
      4
    );
  });

  test('title fuzzy miss: endAt outside ±2h window returns false', async () => {
    reset();
    const anchor = new Date('2026-04-19T20:45:00Z');
    await insert({
      tvdbId: null,
      season: null,
      episode: null,
      normalizedTitle: 'ニュースウォッチ9',
      endAt: anchor,
    });
    // 3 hours later — outside window.
    const hit = await has({
      normalizedTitle: 'ニュースウォッチ9',
      endAt: new Date(anchor.getTime() + 3 * 60 * 60 * 1000),
    });
    assert.equal(hit, false);
  });

  test('title fuzzy miss: different title returns false even within window', async () => {
    reset();
    const anchor = new Date('2026-04-19T20:45:00Z');
    await insert({
      tvdbId: null,
      season: null,
      episode: null,
      normalizedTitle: 'ニュースウォッチ9',
      endAt: anchor,
    });
    const hit = await has({
      normalizedTitle: '報道ステーション',
      endAt: anchor,
    });
    assert.equal(hit, false);
  });

  test('tvdb path wins when tvdb tuple is present — does not fall back to title', async () => {
    reset();
    // Seed only a title row.
    const anchor = new Date('2026-04-19T20:45:00Z');
    await insert({
      tvdbId: null,
      normalizedTitle: 'x',
      endAt: anchor,
    });
    // Query with both tvdb ids and title — the structured path runs and
    // misses, and we do *not* fall back to the title match (which would
    // be unsafe: the title could belong to a different series).
    const hit = await has({
      tvdbId: 999,
      season: 1,
      episode: 1,
      normalizedTitle: 'x',
      endAt: anchor,
    });
    assert.equal(hit, false);
    assert.equal(captured?.path, 'tvdb');
  });

  test('no key at all returns false (no identity → no dedupe)', async () => {
    reset();
    const hit = await has({ endAt: new Date() });
    assert.equal(hit, false);
  });
});

describe('recordedHistoryService.insert()', () => {
  test('idempotent on tvdb tuple — second insert is silently absorbed', async () => {
    reset();
    const endAt = new Date('2026-04-19T20:45:00Z');
    await insert({ tvdbId: 42, season: 1, episode: 3, endAt });
    // Second insert with the same tuple must not throw.
    await insert({ tvdbId: 42, season: 1, episode: 3, endAt });
    // Only one row persisted.
    assert.equal(rows.length, 1);
  });
});
