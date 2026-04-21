// Unit tests for the pure-function diff logic in epgLiveService.
//
// We deliberately only exercise diffProgramUpdate() here — it takes
// (oldProgram, newProgram, recordingsList) and returns the action list the
// runtime applies against DB + pg-boss. Keeping this pure means the tests
// don't need a DB or Mirakurun.
//
// Run: `npm run test:unit` (or: node --import tsx --test src/services/epgLiveService.test.ts)

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Import from the pure module (no DB/boss side-effects) so the test can run
// without DATABASE_URL set.
import { diffProgramUpdate, type RecordingForDiff } from './epgLiveDiff.ts';

const baseRecording: RecordingForDiff = {
  id: 'rec_1',
  programId: 'svc-1_2026-04-19T12:00:00.000Z',
  startAt: '2026-04-19T12:00:00.000Z',
  endAt: '2026-04-19T12:30:00.000Z',
  state: 'scheduled',
  marginPost: 30,
  originalStartAt: null,
  originalEndAt: null,
  extendedBySec: 0,
};

test('diff: no-op when endAt unchanged', () => {
  const old = {
    id: 'svc-1_2026-04-19T12:00:00.000Z',
    startAt: '2026-04-19T12:00:00.000Z',
    endAt: '2026-04-19T12:30:00.000Z',
  };
  const actions = diffProgramUpdate(old, old, [baseRecording]);
  assert.deepEqual(actions, []);
});

test('diff: mismatched ids → empty', () => {
  const old = { id: 'a', startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:30:00.000Z' };
  const incoming = { id: 'b', startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:35:00.000Z' };
  assert.deepEqual(diffProgramUpdate(old, incoming, [baseRecording]), []);
});

test('diff: +5min extension produces bumpProgramRevision + updateEnd', () => {
  const programId = 'svc-1_2026-04-19T12:00:00.000Z';
  const old = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:30:00.000Z' };
  const incoming = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:35:00.000Z' };
  const actions = diffProgramUpdate(old, incoming, [baseRecording]);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, 'bumpProgramRevision');
  assert.equal(actions[1].type, 'updateEnd');
  if (actions[1].type === 'updateEnd') {
    assert.equal(actions[1].recordingId, 'rec_1');
    assert.equal(actions[1].newEndAt, '2026-04-19T12:35:00.000Z');
    assert.equal(actions[1].prevEndAt, '2026-04-19T12:30:00.000Z');
    assert.equal(actions[1].captureOriginal, true);
    assert.equal(actions[1].state, 'scheduled');
  }
});

test('diff: sub-second drift only bumps revision, no reserve touched', () => {
  const programId = 'svc-1_2026-04-19T12:00:00.000Z';
  const old = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:30:00.000Z' };
  // 500ms shift — under the 1s threshold.
  const incoming = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:30:00.500Z' };
  const actions = diffProgramUpdate(old, incoming, [baseRecording]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'bumpProgramRevision');
});

test('diff: reserves already shifted once preserve originalEndAt (captureOriginal=false)', () => {
  const programId = 'svc-1_2026-04-19T12:00:00.000Z';
  const old = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:35:00.000Z' };
  const incoming = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:40:00.000Z' };
  const reserve: RecordingForDiff = {
    ...baseRecording,
    endAt: '2026-04-19T12:35:00.000Z',
    originalStartAt: '2026-04-19T12:00:00.000Z',
    originalEndAt: '2026-04-19T12:30:00.000Z',
    extendedBySec: 300,
  };
  const actions = diffProgramUpdate(old, incoming, [reserve]);
  const updateEnd = actions.find((a) => a.type === 'updateEnd');
  assert.ok(updateEnd && updateEnd.type === 'updateEnd');
  assert.equal(updateEnd.captureOriginal, false);
});

test('diff: done/failed reserves are not touched', () => {
  const programId = 'svc-1_2026-04-19T12:00:00.000Z';
  const old = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:30:00.000Z' };
  const incoming = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:40:00.000Z' };
  const reserves: RecordingForDiff[] = [
    { ...baseRecording, id: 'rv_done', state: 'done' },
    { ...baseRecording, id: 'rv_failed', state: 'failed' },
    { ...baseRecording, id: 'rv_cancelled', state: 'cancelled' },
  ];
  const actions = diffProgramUpdate(old, incoming, reserves);
  const updateEnds = actions.filter((a) => a.type === 'updateEnd');
  assert.equal(updateEnds.length, 0);
});

test('diff: recording-state reserves still produce updateEnd (live extension)', () => {
  const programId = 'svc-1_2026-04-19T12:00:00.000Z';
  const old = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:30:00.000Z' };
  const incoming = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:45:00.000Z' };
  const reserve: RecordingForDiff = { ...baseRecording, state: 'recording' };
  const actions = diffProgramUpdate(old, incoming, [reserve]);
  const updateEnd = actions.find((a) => a.type === 'updateEnd');
  assert.ok(updateEnd && updateEnd.type === 'updateEnd');
  assert.equal(updateEnd.state, 'recording');
});

test('diff: multiple reserves on same program all get updateEnd', () => {
  const programId = 'svc-1_2026-04-19T12:00:00.000Z';
  const old = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:30:00.000Z' };
  const incoming = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:35:00.000Z' };
  const reserves: RecordingForDiff[] = [
    { ...baseRecording, id: 'rv_a' },
    { ...baseRecording, id: 'rv_b', state: 'recording' },
  ];
  const actions = diffProgramUpdate(old, incoming, reserves);
  const updateEnds = actions.filter((a) => a.type === 'updateEnd');
  assert.equal(updateEnds.length, 2);
  const ids = new Set(updateEnds.map((a) => a.type === 'updateEnd' ? a.recordingId : ''));
  assert.ok(ids.has('rv_a'));
  assert.ok(ids.has('rv_b'));
});

test('diff: reserves for other programs are ignored', () => {
  const programId = 'svc-1_2026-04-19T12:00:00.000Z';
  const other = 'svc-1_2026-04-19T13:00:00.000Z';
  const old = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:30:00.000Z' };
  const incoming = { id: programId, startAt: '2026-04-19T12:00:00.000Z', endAt: '2026-04-19T12:35:00.000Z' };
  const reserves: RecordingForDiff[] = [
    { ...baseRecording, id: 'rv_other', programId: other },
  ];
  const actions = diffProgramUpdate(old, incoming, reserves);
  const updateEnds = actions.filter((a) => a.type === 'updateEnd');
  assert.equal(updateEnds.length, 0);
});
