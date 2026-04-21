// Unit tests for the Phase 7 exclusion predicates baked into
// `rulePredicate()`. Runs as pure logic — no DB, no network. The table
// walks through: base match OK → denied by NG keyword → denied by genre
// → denied by time range → passes when none of the deny-lists match.
//
// Run: `node --import tsx --test src/services/ruleExpanderExclusions.test.ts`

// ruleExpander.ts transitively imports db/client.ts which asserts on
// DATABASE_URL at module load. `dotenv/config` populates it from .env
// so the test can import the predicate without touching the DB. Nothing
// in these tests actually queries Postgres — we only need the module
// graph to initialize.
import 'dotenv/config';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rulePredicate } from './ruleExpander.ts';
import type { Rule } from '../schemas/rule.ts';
import type { Program } from '../schemas/program.ts';

// Anchor `now` at a fixed point well before all the test programs —
// otherwise the "program already ended" early-exit would hide failures.
const NOW_MS = Date.parse('2026-04-19T00:00:00+09:00');

// Build a keyword rule with the exclusion lists defaulted to empty.
// Individual cases spread overrides on top. Everything else mirrors the
// Rule schema's defaults so we can feed it straight to rulePredicate.
function mkRule(over: Partial<Rule> = {}): Rule {
  return {
    id: 1,
    name: 'サザエさん録画',
    keyword: 'サザエさん',
    channels: [],
    enabled: true,
    matches: 0,
    nextMatch: null,
    priority: 'medium',
    quality: '1080i',
    skipReruns: false,
    kind: 'keyword',
    ngKeywords: [],
    genreDeny: [],
    timeRangeDeny: [],
    ...over,
  };
}

function mkProgram(over: Partial<Program> = {}): Program {
  return {
    id: 'cx_2026-04-19T18:30',
    ch: 'cx',
    startAt: '2026-04-19T18:30:00+09:00',
    endAt:   '2026-04-19T19:00:00+09:00',
    title: 'サザエさん',
    genre: { key: 'anime', label: 'アニメ', dot: '' },
    ep: null,
    series: null,
    ...over,
  };
}

describe('rulePredicate — exclusions (Phase 7)', () => {
  // ------------------------------------------------------------------
  test('base match: no deny lists → passes', () => {
    const rule = mkRule();
    const prog = mkProgram();
    assert.equal(rulePredicate(rule, prog, NOW_MS), true);
  });

  // ------------------------------------------------------------------
  test('ngKeywords: title contains 傑作選 → denied', () => {
    const rule = mkRule({ ngKeywords: ['傑作選'] });
    const prog = mkProgram({ title: 'サザエさん 傑作選スペシャル' });
    assert.equal(rulePredicate(rule, prog, NOW_MS), false);
  });

  test('ngKeywords: title does NOT contain any NG term → passes', () => {
    const rule = mkRule({ ngKeywords: ['傑作選', '総集編'] });
    const prog = mkProgram({ title: 'サザエさん' });
    assert.equal(rulePredicate(rule, prog, NOW_MS), true);
  });

  test('ngKeywords: empty-string entries are ignored', () => {
    const rule = mkRule({ ngKeywords: [''] });
    const prog = mkProgram();
    assert.equal(rulePredicate(rule, prog, NOW_MS), true);
  });

  // ------------------------------------------------------------------
  test('genreDeny: program genre in deny list → denied', () => {
    const rule = mkRule({ genreDeny: ['news'] });
    const prog = mkProgram({
      title: 'サザエさん', // still matches keyword
      genre: { key: 'news', label: 'ニュース', dot: '' },
    });
    assert.equal(rulePredicate(rule, prog, NOW_MS), false);
  });

  test('genreDeny: program genre not in deny list → passes', () => {
    const rule = mkRule({ genreDeny: ['news', 'info'] });
    const prog = mkProgram(); // genre.key = 'anime'
    assert.equal(rulePredicate(rule, prog, NOW_MS), true);
  });

  // ------------------------------------------------------------------
  test('timeRangeDeny: JST start within range → denied', () => {
    const rule = mkRule({ timeRangeDeny: [{ start: '02:00', end: '05:00' }] });
    const prog = mkProgram({
      startAt: '2026-04-19T03:30:00+09:00',
      endAt:   '2026-04-19T04:00:00+09:00',
    });
    assert.equal(rulePredicate(rule, prog, NOW_MS), false);
  });

  test('timeRangeDeny: JST start outside range → passes', () => {
    const rule = mkRule({ timeRangeDeny: [{ start: '02:00', end: '05:00' }] });
    const prog = mkProgram({
      startAt: '2026-04-19T18:30:00+09:00',
      endAt:   '2026-04-19T19:00:00+09:00',
    });
    assert.equal(rulePredicate(rule, prog, NOW_MS), true);
  });

  test('timeRangeDeny: range that wraps past midnight catches 23:30', () => {
    const rule = mkRule({ timeRangeDeny: [{ start: '23:00', end: '05:00' }] });
    const prog = mkProgram({
      startAt: '2026-04-19T23:30:00+09:00',
      endAt:   '2026-04-20T00:00:00+09:00',
    });
    assert.equal(rulePredicate(rule, prog, NOW_MS), false);
  });

  test('timeRangeDeny: range that wraps past midnight also catches 01:30', () => {
    const rule = mkRule({ timeRangeDeny: [{ start: '23:00', end: '05:00' }] });
    const prog = mkProgram({
      startAt: '2026-04-19T01:30:00+09:00',
      endAt:   '2026-04-19T02:00:00+09:00',
    });
    assert.equal(rulePredicate(rule, prog, NOW_MS), false);
  });

  test('timeRangeDeny: boundary — exclusive end', () => {
    const rule = mkRule({ timeRangeDeny: [{ start: '02:00', end: '05:00' }] });
    // 05:00 is the exclusive end; 04:59 hits, 05:00 passes.
    const hit = mkProgram({
      startAt: '2026-04-19T04:59:00+09:00',
      endAt:   '2026-04-19T05:29:00+09:00',
    });
    const miss = mkProgram({
      startAt: '2026-04-19T05:00:00+09:00',
      endAt:   '2026-04-19T05:30:00+09:00',
    });
    assert.equal(rulePredicate(rule, hit, NOW_MS), false);
    assert.equal(rulePredicate(rule, miss, NOW_MS), true);
  });

  // ------------------------------------------------------------------
  test('combination: all three deny lists set, none hit → passes', () => {
    const rule = mkRule({
      ngKeywords: ['傑作選'],
      genreDeny: ['news'],
      timeRangeDeny: [{ start: '02:00', end: '05:00' }],
    });
    const prog = mkProgram(); // anime, 18:30, title "サザエさん"
    assert.equal(rulePredicate(rule, prog, NOW_MS), true);
  });

  test('combination: only genre hits → denied (one is enough)', () => {
    const rule = mkRule({
      ngKeywords: ['傑作選'],
      genreDeny: ['anime'],
      timeRangeDeny: [{ start: '02:00', end: '05:00' }],
    });
    const prog = mkProgram();
    assert.equal(rulePredicate(rule, prog, NOW_MS), false);
  });

  // ------------------------------------------------------------------
  test('base mismatch still wins: keyword miss isn\'t rescued by empty denies', () => {
    const rule = mkRule({ keyword: 'ちびまる子ちゃん' });
    const prog = mkProgram(); // title = "サザエさん"
    assert.equal(rulePredicate(rule, prog, NOW_MS), false);
  });
});
