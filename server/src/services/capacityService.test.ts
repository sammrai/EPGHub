// Unit tests for the pure deletion-plan picker. The IO layer (statfs,
// unlink, drizzle) is covered by the e2e suite; here we only exercise
// the selection logic so the math stays honest under weird inputs.
//
// Run: `npm run test:unit`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickDeletionCandidates,
  thresholdBytes,
  type SweepCandidate,
} from './capacityPolicy.ts';

const GIB = 1024 * 1024 * 1024;

function row(
  id: string,
  recordedAt: string,
  sizeBytes: number,
  opts: { protected?: boolean; state?: string } = {}
): SweepCandidate {
  return {
    id,
    sizeBytes,
    recordedAt: new Date(recordedAt),
    protectedFlag: opts.protected ?? false,
    state: opts.state ?? 'ready',
  };
}

describe('pickDeletionCandidates', () => {
  test('no-op when free >= threshold', () => {
    const rows = [row('a', '2026-01-01T00:00:00Z', 5 * GIB)];
    const plan = pickDeletionCandidates(rows, /*free*/ 100, /*threshold*/ 10);
    assert.deepEqual(plan.ids, []);
    assert.equal(plan.plannedFreedBytes, 0);
  });

  test('deletes oldest first until threshold is met', () => {
    const rows = [
      row('new', '2026-03-01T00:00:00Z', 3 * GIB),
      row('old', '2026-01-01T00:00:00Z', 2 * GIB),
      row('mid', '2026-02-01T00:00:00Z', 2 * GIB),
    ];
    // free=0, threshold=3GiB → need to free at least 3 GiB.
    const plan = pickDeletionCandidates(rows, 0, 3 * GIB);
    // Oldest (old, 2G) then mid (2G) → total 4G crosses 3G threshold.
    assert.deepEqual(plan.ids, ['old', 'mid']);
    assert.equal(plan.plannedFreedBytes, 4 * GIB);
  });

  test('skips protected rows regardless of age', () => {
    const rows = [
      row('oldP', '2026-01-01T00:00:00Z', 10 * GIB, { protected: true }),
      row('new', '2026-03-01T00:00:00Z', 10 * GIB),
    ];
    const plan = pickDeletionCandidates(rows, 0, 5 * GIB);
    assert.deepEqual(plan.ids, ['new']);
    assert.equal(plan.plannedFreedBytes, 10 * GIB);
  });

  test('skips rows whose state is not ready (in-encode, etc.)', () => {
    const rows = [
      row('encOld', '2026-01-01T00:00:00Z', 10 * GIB, { state: 'encoding' }),
      row('queued', '2026-01-02T00:00:00Z', 10 * GIB, { state: 'queued' }),
      row('readyNew', '2026-03-01T00:00:00Z', 10 * GIB),
    ];
    const plan = pickDeletionCandidates(rows, 0, 5 * GIB);
    assert.deepEqual(plan.ids, ['readyNew']);
  });

  test('stops as soon as simulated free crosses threshold', () => {
    const rows = [
      row('a', '2026-01-01T00:00:00Z', 1 * GIB),
      row('b', '2026-01-02T00:00:00Z', 1 * GIB),
      row('c', '2026-01-03T00:00:00Z', 1 * GIB),
      row('d', '2026-01-04T00:00:00Z', 1 * GIB),
    ];
    // free=1G, threshold=3G → need +2G → picks a, b (after a we have 2G, still
    // < 3G; after b we have 3G which meets threshold so we stop).
    const plan = pickDeletionCandidates(rows, 1 * GIB, 3 * GIB);
    assert.deepEqual(plan.ids, ['a', 'b']);
  });

  test('returns empty list when all candidates are protected / in-encode', () => {
    const rows = [
      row('a', '2026-01-01T00:00:00Z', 10 * GIB, { protected: true }),
      row('b', '2026-01-02T00:00:00Z', 10 * GIB, { state: 'encoding' }),
    ];
    const plan = pickDeletionCandidates(rows, 0, 5 * GIB);
    assert.deepEqual(plan.ids, []);
    assert.equal(plan.plannedFreedBytes, 0);
  });

  test('handles zero-size rows (counted but contribute nothing)', () => {
    const rows = [
      row('zero', '2026-01-01T00:00:00Z', 0),
      row('real', '2026-02-01T00:00:00Z', 2 * GIB),
    ];
    const plan = pickDeletionCandidates(rows, 0, 1 * GIB);
    // zero doesn't move the needle → picks real next.
    assert.deepEqual(plan.ids, ['zero', 'real']);
    assert.equal(plan.plannedFreedBytes, 2 * GIB);
  });

  test('negative sizes are clamped to zero', () => {
    const rows = [
      row('weird', '2026-01-01T00:00:00Z', -5 * GIB),
      row('real', '2026-02-01T00:00:00Z', 2 * GIB),
    ];
    const plan = pickDeletionCandidates(rows, 0, 1 * GIB);
    assert.deepEqual(plan.ids, ['weird', 'real']);
    // weird contributes 0, real 2G.
    assert.equal(plan.plannedFreedBytes, 2 * GIB);
  });

  test('input order is irrelevant — sort is by recordedAt asc', () => {
    const rows = [
      row('c', '2026-03-01T00:00:00Z', 1 * GIB),
      row('a', '2026-01-01T00:00:00Z', 1 * GIB),
      row('b', '2026-02-01T00:00:00Z', 1 * GIB),
    ];
    const plan = pickDeletionCandidates(rows, 0, 2 * GIB);
    // a (oldest), b → 2G reaches threshold.
    assert.deepEqual(plan.ids, ['a', 'b']);
  });
});

describe('thresholdBytes', () => {
  // Tests guard the resolution order:
  //   1. env DISK_SWEEP_MIN_FREE_GB  (positive, finite)
  //   2. 5% of totalBytes
  //   3. default 10 GiB (total==0 && env unset/invalid)

  test('env DISK_SWEEP_MIN_FREE_GB wins when set to a positive number', () => {
    const prev = process.env.DISK_SWEEP_MIN_FREE_GB;
    process.env.DISK_SWEEP_MIN_FREE_GB = '25';
    try {
      assert.equal(thresholdBytes(1000 * GIB), 25 * GIB);
    } finally {
      if (prev === undefined) delete process.env.DISK_SWEEP_MIN_FREE_GB;
      else process.env.DISK_SWEEP_MIN_FREE_GB = prev;
    }
  });

  test('falls back to 5% when env is unset', () => {
    const prev = process.env.DISK_SWEEP_MIN_FREE_GB;
    delete process.env.DISK_SWEEP_MIN_FREE_GB;
    try {
      assert.equal(thresholdBytes(1000), 50); // 1000 * 0.05
    } finally {
      if (prev !== undefined) process.env.DISK_SWEEP_MIN_FREE_GB = prev;
    }
  });

  test('falls back to 10 GiB when both env and total are unusable', () => {
    const prev = process.env.DISK_SWEEP_MIN_FREE_GB;
    delete process.env.DISK_SWEEP_MIN_FREE_GB;
    try {
      assert.equal(thresholdBytes(0), 10 * GIB);
    } finally {
      if (prev !== undefined) process.env.DISK_SWEEP_MIN_FREE_GB = prev;
    }
  });

  test('rejects zero / negative / non-finite env values', () => {
    const prev = process.env.DISK_SWEEP_MIN_FREE_GB;
    try {
      for (const bad of ['0', '-5', 'abc', '']) {
        process.env.DISK_SWEEP_MIN_FREE_GB = bad;
        assert.equal(thresholdBytes(2000), 100, `bad value ${JSON.stringify(bad)}`);
      }
    } finally {
      if (prev === undefined) delete process.env.DISK_SWEEP_MIN_FREE_GB;
      else process.env.DISK_SWEEP_MIN_FREE_GB = prev;
    }
  });
});
