// Unit tests for the DropChecker.  We synthesize 188-byte TS packets by
// hand so each scenario targets exactly one thing — no dependency on a
// real TS fixture.
//
// Run: `npm run test:unit`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DropChecker } from './dropChecker.ts';

const TS_PACKET_SIZE = 188;

/**
 * Build one TS packet with the given PID, continuity_counter,
 * adaptation_field_control (default 01 = payload only), scrambling
 * control (default 00) and transport_error_indicator (default false).
 */
function makePacket(opts: {
  pid: number;
  cc: number;
  afc?: number;
  scr?: number;
  tei?: boolean;
  fill?: number;
}): Buffer {
  const afc = opts.afc ?? 0b01;  // payload only
  const scr = opts.scr ?? 0;
  const tei = opts.tei ?? false;
  const fill = opts.fill ?? 0xff;

  const b = Buffer.alloc(TS_PACKET_SIZE, fill);
  b[0] = 0x47;
  // byte 1: TEI | PUSI | TP | PID high 5
  b[1] = (tei ? 0x80 : 0x00) | ((opts.pid >> 8) & 0x1f);
  // byte 2: PID low 8
  b[2] = opts.pid & 0xff;
  // byte 3: scrambling(2) | afc(2) | cc(4)
  b[3] = ((scr & 0x03) << 6) | ((afc & 0x03) << 4) | (opts.cc & 0x0f);
  return b;
}

describe('DropChecker', () => {
  test('(a) 3 packets on PID 0x100 with correct continuity → 0 drops', () => {
    const dc = new DropChecker();
    const stream = Buffer.concat([
      makePacket({ pid: 0x100, cc: 5 }),
      makePacket({ pid: 0x100, cc: 6 }),
      makePacket({ pid: 0x100, cc: 7 }),
    ]);
    dc.feed(stream);
    const s = dc.summary();
    assert.equal(s.dropCnt, 0);
    assert.equal(s.errorCnt, 0);
    assert.equal(s.scramblingCnt, 0);
    assert.deepEqual(s.perPid['256'], { err: 0, drop: 0, scr: 0 });
  });

  test('(b) 3 packets on PID 0x100 with jump 5→7 → 1 drop recorded', () => {
    const dc = new DropChecker();
    dc.feed(Buffer.concat([
      makePacket({ pid: 0x100, cc: 5 }),
      makePacket({ pid: 0x100, cc: 7 }),  // expected 6; one packet missing
      makePacket({ pid: 0x100, cc: 8 }),
    ]));
    const s = dc.summary();
    assert.equal(s.dropCnt, 1, 'exactly 1 drop');
    assert.equal(s.perPid['256'].drop, 1);
  });

  test('(c) packet with scrambling_control=2 → 1 scrambled', () => {
    const dc = new DropChecker();
    dc.feed(makePacket({ pid: 0x200, cc: 0, scr: 2 }));
    const s = dc.summary();
    assert.equal(s.scramblingCnt, 1);
    assert.equal(s.perPid['512'].scr, 1);
    assert.equal(s.dropCnt, 0);
  });

  test('(d) mixed-PID interleave: drop only on one PID', () => {
    const dc = new DropChecker();
    dc.feed(Buffer.concat([
      makePacket({ pid: 0x100, cc: 0 }),
      makePacket({ pid: 0x101, cc: 10 }),
      makePacket({ pid: 0x100, cc: 1 }),    // OK
      makePacket({ pid: 0x101, cc: 12 }),   // jump 10→12 → 1 drop on 0x101
      makePacket({ pid: 0x100, cc: 2 }),    // OK
      makePacket({ pid: 0x101, cc: 13 }),   // OK
    ]));
    const s = dc.summary();
    assert.equal(s.dropCnt, 1);
    assert.equal(s.perPid['256'].drop, 0, 'PID 0x100 clean');
    assert.equal(s.perPid['257'].drop, 1, 'PID 0x101 1 drop');
  });

  test('TEI bit counts toward errorCnt', () => {
    const dc = new DropChecker();
    dc.feed(makePacket({ pid: 0x300, cc: 0, tei: true }));
    const s = dc.summary();
    assert.equal(s.errorCnt, 1);
    assert.equal(s.perPid['768'].err, 1);
  });

  test('NULL packets (PID 0x1FFF) are ignored', () => {
    const dc = new DropChecker();
    dc.feed(Buffer.concat([
      makePacket({ pid: 0x1fff, cc: 0 }),
      makePacket({ pid: 0x1fff, cc: 5 }),   // would be a drop if counted
    ]));
    const s = dc.summary();
    assert.equal(s.dropCnt, 0);
    assert.equal(Object.keys(s.perPid).length, 0);
  });

  test('duplicate packet (cc === prev) is NOT counted as a drop', () => {
    const dc = new DropChecker();
    dc.feed(Buffer.concat([
      makePacket({ pid: 0x100, cc: 3 }),
      makePacket({ pid: 0x100, cc: 3 }),  // duplicate allowed by spec
      makePacket({ pid: 0x100, cc: 4 }),
    ]));
    assert.equal(dc.summary().dropCnt, 0);
  });

  test('adaptation-only packets (afc=10) do not advance cc', () => {
    const dc = new DropChecker();
    dc.feed(Buffer.concat([
      makePacket({ pid: 0x100, cc: 5 }),                // payload
      makePacket({ pid: 0x100, cc: 5, afc: 0b10 }),     // adaptation only; cc unchanged by spec
      makePacket({ pid: 0x100, cc: 6 }),                // next payload cc=6 — OK
    ]));
    assert.equal(dc.summary().dropCnt, 0);
  });

  test('handles chunk boundaries in the middle of a packet', () => {
    const dc = new DropChecker();
    const pkt1 = makePacket({ pid: 0x100, cc: 0 });
    const pkt2 = makePacket({ pid: 0x100, cc: 1 });
    // Split pkt1 in half + glue the back half to pkt2.
    const firstHalf = pkt1.subarray(0, 100);
    const rest = Buffer.concat([pkt1.subarray(100), pkt2]);
    dc.feed(firstHalf);
    dc.feed(rest);
    const s = dc.summary();
    assert.equal(s.dropCnt, 0);
    assert.equal(s.perPid['256'].drop, 0);
  });

  test('realigns after a mid-stream garbage run', () => {
    const dc = new DropChecker();
    const garbage = Buffer.alloc(50, 0x00);
    const pkt = makePacket({ pid: 0x100, cc: 0 });
    const pkt2 = makePacket({ pid: 0x100, cc: 1 });
    dc.feed(Buffer.concat([garbage, pkt, pkt2]));
    const s = dc.summary();
    assert.equal(s.perPid['256']?.drop ?? 0, 0);
  });
});
