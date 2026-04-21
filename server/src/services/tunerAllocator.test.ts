// Tests for the priority-based slot allocator. Uses Node's built-in
// `node:test` runner (no framework deps). Run via `npm test`.
//
// We build minimal Recording / Channel / MrTunerDevice fixtures inline —
// the allocator only touches a handful of fields (id, ch, startAt, endAt,
// priority) so we don't bother constructing complete DB rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from './tunerAllocator.ts';
import type { Recording } from '../schemas/recording.ts';
import type { Channel } from '../schemas/channel.ts';
import type { MrTunerDevice } from '../integrations/mirakurun/types.ts';

// Tiny helpers so tests read declaratively.
function r(
  id: string,
  ch: string,
  startHour: number,
  endHour: number,
  priority: Recording['priority']
): Recording {
  const pad = (h: number) => String(h).padStart(2, '0');
  return {
    id,
    programId: `${ch}_${pad(startHour)}`,
    ch,
    startAt: `2026-04-19T${pad(startHour)}:00:00+09:00`,
    endAt: `2026-04-19T${pad(endHour)}:00:00+09:00`,
    title: `prog-${id}`,
    priority,
    quality: '1080i',
    keepRaw: false,
    marginPre: 0,
    marginPost: 0,
    source: { kind: 'once' },
    state: 'scheduled',
  };
}

function ch(id: string, type: 'GR' | 'BS' | 'CS'): Channel {
  return { id, name: id, short: id, number: '000', type, color: '#000', enabled: true, source: 'test' };
}

function dev(index: number, type: 'GR' | 'BS' | 'CS' | 'SKY'): MrTunerDevice {
  return {
    index,
    name: `t${index}`,
    types: [type],
    users: [],
    isAvailable: true,
    isRemote: false,
    isFree: true,
    isUsing: false,
    isFault: false,
  };
}

// ---------------------------------------------------------------------------
// (a) simulcast — two reserves on the SAME channel in the same window share
// a single physical tuner, leaving the other free.
test('allocator: same-channel simulcast shares a tuner', () => {
  const reserves = [
    r('a', 'nhk-g', 19, 20, 'medium'),
    r('b', 'nhk-g', 19, 20, 'medium'),
  ];
  const channels = [ch('nhk-g', 'GR')];
  const tuners = [dev(0, 'GR'), dev(1, 'GR')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 2);
  assert.equal(out.preempted.length, 0);
  assert.equal(out.allocated.get('a'), out.allocated.get('b'));
});

// (b) preemption — when more distinct channels overlap than tuners exist,
// the highest-priority reserves win; losers land in `preempted`.
test('allocator: high priority preempts low on the same slot', () => {
  const reserves = [
    r('low', 'tbs', 19, 20, 'low'),
    r('hi', 'nhk-g', 19, 20, 'high'),
    r('med', 'fuji', 19, 20, 'medium'),
  ];
  const channels = [ch('nhk-g', 'GR'), ch('tbs', 'GR'), ch('fuji', 'GR')];
  const tuners = [dev(0, 'GR'), dev(1, 'GR')];
  const out = allocate(reserves, tuners, { channels });
  // hi + med fit on the 2 tuners; low gets preempted.
  assert.equal(out.allocated.size, 2);
  assert.deepEqual(out.preempted, ['low']);
  assert.ok(out.allocated.has('hi'));
  assert.ok(out.allocated.has('med'));
});

// Same priorities → ties broken by startAt asc, then id asc. Earlier/first
// reserves win; the later one is preempted.
test('allocator: ties broken by startAt then id', () => {
  const reserves = [
    r('z', 'nhk-g', 19, 20, 'medium'),
    r('a', 'tbs', 19, 20, 'medium'),
    r('m', 'fuji', 19, 20, 'medium'),
  ];
  const channels = [ch('nhk-g', 'GR'), ch('tbs', 'GR'), ch('fuji', 'GR')];
  const tuners = [dev(0, 'GR'), dev(1, 'GR')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 2);
  // Same startAt, same priority → id asc: a, m win; z loses.
  assert.deepEqual(out.preempted, ['z']);
});

// (c) type mismatch — a BS reserve can never land on a GR-only tuner.
test('allocator: type mismatch is rejected', () => {
  const reserves = [r('bs1', 'bs1', 19, 20, 'high')];
  const channels = [ch('bs1', 'BS')];
  const tuners = [dev(0, 'GR'), dev(1, 'GR')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 0);
  assert.deepEqual(out.preempted, ['bs1']);
});

// SKY-capable tuners accept CS reserves (we collapse SKY→CS in the
// aggregator, the allocator must stay consistent with that).
test('allocator: SKY tuner accepts CS reserves', () => {
  const reserves = [r('cs1', 'cs1', 19, 20, 'medium')];
  const channels = [ch('cs1', 'CS')];
  const tuners = [dev(0, 'SKY')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 1);
  assert.equal(out.allocated.get('cs1'), 0);
});

// Non-overlapping reserves on *different* channels can share a tuner — the
// allocator shouldn't split them across two devices unnecessarily.
test('allocator: non-overlapping different channels reuse a tuner', () => {
  const reserves = [
    r('early', 'tbs', 10, 11, 'medium'),
    r('late', 'fuji', 14, 15, 'medium'),
  ];
  const channels = [ch('tbs', 'GR'), ch('fuji', 'GR')];
  const tuners = [dev(0, 'GR')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 2);
  assert.equal(out.allocated.get('early'), 0);
  assert.equal(out.allocated.get('late'), 0);
});

// 2×BS + 4 overlapping BS reserves across 4 distinct channels at two
// different priorities → top 2 by priority fit, bottom 2 preempt.
test('allocator: 4 overlapping BS reserves, 2 tuners, 2 preempted', () => {
  const reserves = [
    r('hi1', 'bs1', 20, 21, 'high'),
    r('hi2', 'bs2', 20, 21, 'high'),
    r('lo1', 'bs3', 20, 21, 'low'),
    r('lo2', 'bs4', 20, 21, 'low'),
  ];
  const channels = [ch('bs1', 'BS'), ch('bs2', 'BS'), ch('bs3', 'BS'), ch('bs4', 'BS')];
  const tuners = [dev(0, 'BS'), dev(1, 'BS')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 2);
  assert.ok(out.allocated.has('hi1'));
  assert.ok(out.allocated.has('hi2'));
  assert.deepEqual([...out.preempted].sort(), ['lo1', 'lo2']);
});

// Unknown channel (not in the channel list) is treated as unplaceable — we
// shouldn't silently fall back to "any tuner type". The caller can decide
// whether to 404 upstream.
test('allocator: unknown channel lands in preempted', () => {
  const reserves = [r('x', 'ghost-ch', 19, 20, 'high')];
  const channels: Channel[] = [];
  const tuners = [dev(0, 'GR')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 0);
  assert.deepEqual(out.preempted, ['x']);
});

// ---------------------------------------------------------------------------
// (1) 3-way preemption with explicit high/medium/low priorities — verifies
// that priority ordering (not just "first two in input") wins the slots and
// that the specific tuner indices are populated deterministically.
test('allocator: 3-way high/medium/low — low is preempted, slots 0+1 taken', () => {
  // Deliberately put low first in input to confirm it's priority-sorted, not
  // input-order greedy.
  const reserves = [
    r('low', 'tbs', 21, 22, 'low'),
    r('med', 'fuji', 21, 22, 'medium'),
    r('hi', 'nhk-g', 21, 22, 'high'),
  ];
  const channels = [ch('nhk-g', 'GR'), ch('tbs', 'GR'), ch('fuji', 'GR')];
  const tuners = [dev(0, 'GR'), dev(1, 'GR')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 2);
  assert.deepEqual(out.preempted, ['low']);
  // hi is placed first (highest priority) → tuner 0; med second → tuner 1.
  assert.equal(out.allocated.get('hi'), 0);
  assert.equal(out.allocated.get('med'), 1);
});

// (2) Priority tie-break by startAt — 3 medium reserves with distinct
// startAt values. Earliest startAt wins, latest is preempted. Runs the
// allocator twice (shuffled input) to prove the ordering is deterministic.
test('allocator: ties broken by startAt determines who is preempted', () => {
  const channels = [ch('nhk-g', 'GR'), ch('tbs', 'GR'), ch('fuji', 'GR')];
  const tuners = [dev(0, 'GR'), dev(1, 'GR')];
  // Three different startAt hours, all medium, all overlapping at 20:30.
  const reservesA = [
    r('a', 'nhk-g', 19, 21, 'medium'), // starts earliest
    r('b', 'tbs', 20, 21, 'medium'),
    r('c', 'fuji', 20, 21, 'medium'), // same startAt as b → id asc breaks
  ];
  const outA = allocate(reservesA, tuners, { channels });
  // 'a' is earliest; between b and c (same startAt) id asc → b wins.
  assert.equal(outA.allocated.size, 2);
  assert.ok(outA.allocated.has('a'));
  assert.ok(outA.allocated.has('b'));
  assert.deepEqual(outA.preempted, ['c']);

  // Same reserves, different input order → identical result (determinism).
  const outB = allocate([reservesA[2], reservesA[0], reservesA[1]], tuners, { channels });
  assert.deepEqual([...outB.allocated.keys()].sort(), ['a', 'b']);
  assert.deepEqual(outB.preempted, ['c']);
});

// (3) Release cascade — simulate a scheduled row being canceled/deleted and
// re-run the allocator. A previously-conflicting row should be promoted to
// an allocated slot. The allocator is pure/stateless so this really just
// verifies that removing a row from the input changes conflict → allocated.
test('allocator: release cascade promotes preempted row after cancel', () => {
  const channels = [ch('nhk-g', 'GR'), ch('tbs', 'GR'), ch('fuji', 'GR')];
  const tuners = [dev(0, 'GR'), dev(1, 'GR')];
  const full = [
    r('hi', 'nhk-g', 22, 23, 'high'),
    r('med', 'tbs', 22, 23, 'medium'),
    r('low', 'fuji', 22, 23, 'low'),
  ];
  const before = allocate(full, tuners, { channels });
  assert.equal(before.allocated.size, 2);
  assert.deepEqual(before.preempted, ['low']);

  // Cancel 'med' (simulate row deletion from DB input list).
  const remaining = full.filter((x) => x.id !== 'med');
  const after = allocate(remaining, tuners, { channels });
  // 'low' should now be allocated (cascade).
  assert.equal(after.allocated.size, 2);
  assert.equal(after.preempted.length, 0);
  assert.ok(after.allocated.has('hi'));
  assert.ok(after.allocated.has('low'));
});

// (4) Cross-type isolation — GR tuners saturated, but a BS recording with a
// BS-capable tuner free should allocate fine. Verifies that GR pressure
// doesn't leak into BS allocation (and vice versa).
test('allocator: BS reserve unaffected when GR tuners are saturated', () => {
  const channels = [
    ch('nhk-g', 'GR'),
    ch('tbs', 'GR'),
    ch('fuji', 'GR'),
    ch('bs1', 'BS'),
  ];
  const tuners = [dev(0, 'GR'), dev(1, 'GR'), dev(2, 'BS')];
  const reserves = [
    // 3 GR overlapping → one must be preempted (only 2 GR tuners).
    r('gr1', 'nhk-g', 19, 20, 'high'),
    r('gr2', 'tbs', 19, 20, 'high'),
    r('gr3', 'fuji', 19, 20, 'low'),
    // BS in the same time window — must land on the BS tuner regardless.
    r('bs1', 'bs1', 19, 20, 'low'),
  ];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 3);
  assert.ok(out.allocated.has('gr1'));
  assert.ok(out.allocated.has('gr2'));
  assert.ok(out.allocated.has('bs1'));
  assert.equal(out.allocated.get('bs1'), 2); // BS tuner idx
  assert.deepEqual(out.preempted, ['gr3']);
});

// (5) Same-service multiplex across 3 reserves on a single channel — all
// three should share one physical tuner, leaving the other free for an
// unrelated GR reserve instead of eating two slots.
test('allocator: 3 same-channel reserves multiplex onto one tuner', () => {
  const reserves = [
    r('a', 'nhk-g', 19, 20, 'medium'),
    r('b', 'nhk-g', 19, 20, 'medium'),
    r('c', 'nhk-g', 19, 20, 'medium'),
    r('other', 'tbs', 19, 20, 'medium'), // distinct channel → needs its own tuner
  ];
  const channels = [ch('nhk-g', 'GR'), ch('tbs', 'GR')];
  const tuners = [dev(0, 'GR'), dev(1, 'GR')];
  const out = allocate(reserves, tuners, { channels });
  assert.equal(out.allocated.size, 4);
  assert.equal(out.preempted.length, 0);
  // a, b, c share one tuner; 'other' lands on the other.
  const nhkTuner = out.allocated.get('a');
  assert.equal(out.allocated.get('b'), nhkTuner);
  assert.equal(out.allocated.get('c'), nhkTuner);
  assert.notEqual(out.allocated.get('other'), nhkTuner);
});
