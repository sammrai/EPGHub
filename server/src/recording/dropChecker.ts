// -----------------------------------------------------------------
// Pure-TS MPEG-TS drop detector. Feeds arbitrary-size Buffer chunks,
// reassembles them into 188-byte TS packets (sync byte 0x47), and
// tracks per-PID statistics needed by Phase 3:
//
//   - errorCnt:      transport_error_indicator set (bit-errored packet)
//   - dropCnt:       continuity_counter discontinuity (missing packets)
//   - scramblingCnt: transport_scrambling_control != 0 (CA-scrambled)
//
// The continuity_counter (4 bits) is expected to increment by 1 mod 16
// when adaptation_field_control indicates "payload present" (bit 4 of
// byte 3). When the adaptation_field_control indicates adaptation-only
// (bit 4 clear) the counter does NOT advance; we therefore only compare
// against the previous CC for packets that carry payload (ISO 13818-1
// §2.4.3.3). PID 0x1FFF is the NULL packet: skipped entirely.
//
// Implemented from scratch following ARIB TR-B14 / ISO 13818-1 so we
// avoid pulling in `aribts` (native deps / broken types). EPGStation's
// `DropCheckerModel.ts` uses aribts's packetError/packetDrop/packetScr
// events under the hood; we replicate the same PID + counter tracking
// semantics here without the stream chain.
// -----------------------------------------------------------------

export interface PerPidStat {
  /** transport_error_indicator occurrences. */
  err: number;
  /** continuity_counter discontinuity occurrences. */
  drop: number;
  /** scrambling_control != 0 packet count. */
  scr: number;
}

export interface DropSummary {
  errorCnt: number;
  dropCnt: number;
  scramblingCnt: number;
  /** Keyed by decimal PID string (e.g. "256" for PID 0x100). */
  perPid: Record<string, PerPidStat>;
}

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const NULL_PID = 0x1fff;

export class DropChecker {
  private buf: Buffer = Buffer.alloc(0);
  // PID → last counter seen on a payload-present packet. undefined means
  // we haven't seen this PID yet, so the first sample can't be judged.
  private lastCc = new Map<number, number>();
  private errorCnt = 0;
  private dropCnt = 0;
  private scramblingCnt = 0;
  private perPid = new Map<number, PerPidStat>();

  /** Push more bytes. Partial packets at the tail are buffered. */
  feed(chunk: Buffer): void {
    if (chunk.length === 0) return;
    // Fast path when the previous feed ended cleanly on a packet boundary.
    const input = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    // Find the first sync byte. A stream that starts mid-packet can happen
    // with fetch()'s first chunk; realign before we try to parse.
    let offset = this.findSync(input, 0);
    if (offset < 0) {
      // No sync in the whole buffer: keep the last 187 bytes (at most) so a
      // sync byte split across chunks still gets found next time.
      this.buf = input.length > TS_PACKET_SIZE - 1
        ? input.subarray(input.length - (TS_PACKET_SIZE - 1))
        : input;
      return;
    }

    while (offset + TS_PACKET_SIZE <= input.length) {
      if (input[offset] !== TS_SYNC_BYTE) {
        // Lost sync mid-buffer; re-search from the next byte.
        const next = this.findSync(input, offset + 1);
        if (next < 0) {
          offset = input.length; // consume to end; drop remainder
          break;
        }
        offset = next;
        continue;
      }
      this.parsePacket(input, offset);
      offset += TS_PACKET_SIZE;
    }

    this.buf = input.subarray(offset);
  }

  /** Returns the aggregate summary. Safe to call at any point. */
  summary(): DropSummary {
    const perPid: Record<string, PerPidStat> = {};
    for (const [pid, s] of this.perPid) {
      perPid[String(pid)] = { err: s.err, drop: s.drop, scr: s.scr };
    }
    return {
      errorCnt: this.errorCnt,
      dropCnt: this.dropCnt,
      scramblingCnt: this.scramblingCnt,
      perPid,
    };
  }

  // -----------------------------------------------------------
  // Internals
  // -----------------------------------------------------------

  private findSync(b: Buffer, from: number): number {
    // Cheapest: indexOf on a single byte. Then verify the packet after it
    // also starts with 0x47 to reject bytes that happen to be 0x47 inside
    // a payload.
    let i = from;
    while (i < b.length) {
      const idx = b.indexOf(TS_SYNC_BYTE, i);
      if (idx < 0) return -1;
      // Verify by looking 188 bytes ahead — if that's also 0x47 we almost
      // certainly found a real packet boundary. If the buffer is too
      // short to verify, accept the position and let the outer loop
      // decide once more bytes arrive.
      if (idx + TS_PACKET_SIZE >= b.length || b[idx + TS_PACKET_SIZE] === TS_SYNC_BYTE) {
        return idx;
      }
      i = idx + 1;
    }
    return -1;
  }

  private parsePacket(b: Buffer, off: number): void {
    // TS packet layout (bytes 1..3):
    //   byte 1: sync (0x47)
    //   byte 2: [transport_error_indicator (1)]
    //           [payload_unit_start_indicator (1)]
    //           [transport_priority (1)]
    //           [PID high 5 bits]
    //   byte 3: [PID low 8 bits]
    //   byte 4: [transport_scrambling_control (2)]
    //           [adaptation_field_control (2)]
    //           [continuity_counter (4)]
    const b1 = b[off + 1];
    const b2 = b[off + 2];
    const b3 = b[off + 3];
    const tei = (b1 & 0x80) !== 0;
    const pid = ((b1 & 0x1f) << 8) | b2;
    const tsc = (b3 >> 6) & 0x03;
    const afc = (b3 >> 4) & 0x03;
    const cc = b3 & 0x0f;

    // NULL packet — skip entirely (never dropped, never scrambled in practice).
    if (pid === NULL_PID) return;

    const stat = this.getOrCreateStat(pid);

    if (tei) {
      stat.err++;
      this.errorCnt++;
    }
    if (tsc !== 0) {
      stat.scr++;
      this.scramblingCnt++;
    }

    // Continuity counter advances only on payload-bearing packets (afc = 01 or 11).
    // See ISO 13818-1 §2.4.3.3: "The continuity_counter shall not be
    // incremented when the adaptation_field_control of the packet equals
    // '00' or '10'".
    const hasPayload = (afc & 0x01) !== 0;
    if (hasPayload) {
      const prev = this.lastCc.get(pid);
      if (prev != null) {
        const expected = (prev + 1) & 0x0f;
        if (cc !== expected) {
          // Duplicate (cc === prev) is explicitly allowed by the spec and
          // must NOT be counted as a drop. Anything else is a discontinuity.
          if (cc !== prev) {
            stat.drop++;
            this.dropCnt++;
          }
        }
      }
      this.lastCc.set(pid, cc);
    }
  }

  private getOrCreateStat(pid: number): PerPidStat {
    let s = this.perPid.get(pid);
    if (!s) {
      s = { err: 0, drop: 0, scr: 0 };
      this.perPid.set(pid, s);
    }
    return s;
  }
}
