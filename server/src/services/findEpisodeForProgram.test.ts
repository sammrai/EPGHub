// Tests for findEpisodeForProgram — the per-program S/E resolver used
// by the auto-matcher. Pure logic, no DB. Run:
//
//   node --import tsx --test src/services/findEpisodeForProgram.test.ts
//
// Resolution order locked here:
//   1. Direct #N match (latest season wins on ties)
//   2. Cumulative #N fallback (broadcaster numbers across seasons —
//      ダンダダン #18 = S1 12話 + S2 6話 で第18話扱い)
//   3. TVDB aired-date match against JST broadcast day
import 'dotenv/config';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { findEpisodeForProgram } from './matchService.ts';

type Episode = { s: number; e: number; aired?: string; name?: string };

// Build a contiguous episode list — 1..count for the given season.
function eps(s: number, count: number, namePrefix?: string): Episode[] {
  return Array.from({ length: count }, (_, i) => ({
    s,
    e: i + 1,
    name: namePrefix ? `${namePrefix} ${i + 1}` : undefined,
  }));
}

const SOME_START = '2026-05-09T18:38:00.000Z';

describe('findEpisodeForProgram — direct #N', () => {
  test('#3 with single-season list → S1E3', () => {
    const list = eps(1, 12);
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル #3');
    assert.deepEqual(hit, { s: 1, e: 3, name: undefined });
  });

  test('zenkaku ＃１２ → S1E12', () => {
    const list = eps(1, 12);
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル　＃１２');
    assert.deepEqual(hit, { s: 1, e: 12, name: undefined });
  });

  test('multi-season + collision → highest season wins', () => {
    // Both S1 and S2 have an E5; the matcher picks S2 (the latest).
    const list: Episode[] = [
      ...eps(1, 6, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル #5');
    assert.deepEqual(hit, { s: 2, e: 5, name: 'S2 5' });
  });
});

describe('findEpisodeForProgram — cumulative fallback', () => {
  test('ダンダダン #18 with S1=12, S2=6 → S2E6', () => {
    // The motivating case. Broadcaster numbers continuously across
    // seasons; TVDB resets per season. Direct e===18 match fails, the
    // cumulative walker (12 < 18 ≤ 18) hits S2E(18-12)=S2E6.
    const list: Episode[] = [
      ...eps(1, 12, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(
      list,
      SOME_START,
      'ダンダダン　＃１８[再]「家族になりました」',
    );
    assert.deepEqual(hit, { s: 2, e: 6, name: 'S2 6' });
  });

  test('S1=12, S2=12, #20 → S2E8', () => {
    const list: Episode[] = [
      ...eps(1, 12),
      ...eps(2, 12),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, '#20');
    assert.deepEqual(hit, { s: 2, e: 8, name: undefined });
  });

  test('S1=12, S2=6, S3=4, #20 → S3E2', () => {
    const list: Episode[] = [
      ...eps(1, 12),
      ...eps(2, 6),
      ...eps(3, 4),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, '#20');
    assert.deepEqual(hit, { s: 3, e: 2, name: undefined });
  });

  test('cumulative does not steal a direct match', () => {
    // S1 has E15 directly, so #15 must stay on S1 even though the
    // cumulative formula would also be valid.
    const list: Episode[] = [
      ...eps(1, 20, 'S1'),
      ...eps(2, 5, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, '#15');
    assert.deepEqual(hit, { s: 1, e: 15, name: 'S1 15' });
  });

  test('out-of-range #N returns null (no aired hint)', () => {
    const list: Episode[] = [
      ...eps(1, 12),
      ...eps(2, 6),
    ];
    // #99 is past the entire run — neither direct nor cumulative match.
    const hit = findEpisodeForProgram(list, SOME_START, '#99');
    assert.equal(hit, null);
  });

  test('specials season (s=0) is skipped from cumulative walk', () => {
    // S0 specials shouldn't count toward the broadcaster's numbering.
    const list: Episode[] = [
      ...eps(0, 5, 'SP'),
      ...eps(1, 12, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル #18');
    assert.deepEqual(hit, { s: 2, e: 6, name: 'S2 6' });
  });
});

describe('findEpisodeForProgram — aired fallback', () => {
  test('no #N in title → use broadcast-day aired match', () => {
    // jstBroadcastDay('2026-05-09T18:38:00.000Z') = 2026-05-10 03:38 JST
    // shifted -5h = 2026-05-09 (so the broadcast day is 2026-05-09).
    const list: Episode[] = [
      { s: 1, e: 7, aired: '2026-05-09', name: 'aired hit' },
      { s: 1, e: 8, aired: '2026-05-16' },
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル「副題」');
    assert.deepEqual(hit, { s: 1, e: 7, name: 'aired hit' });
  });

  test('no signal → null', () => {
    const list: Episode[] = [{ s: 1, e: 1 }];
    const hit = findEpisodeForProgram(list, SOME_START, '無題');
    assert.equal(hit, null);
  });
});
