import { describe, expect, it } from 'vitest';
import { addDays, jstTodayYmd } from './broadcastDay';

describe('jstTodayYmd', () => {
  // 放送日境界は JST 05:00。コメントの例:
  //   2026-04-19 02:00 JST → 放送日 2026-04-18
  //   2026-04-19 05:00 JST → 放送日 2026-04-19
  it('02:00 JST は前放送日を返す', () => {
    const now = new Date('2026-04-19T02:00:00+09:00');
    expect(jstTodayYmd(now)).toBe('2026-04-18');
  });

  it('05:00 JST ちょうどで当日に切り替わる', () => {
    const now = new Date('2026-04-19T05:00:00+09:00');
    expect(jstTodayYmd(now)).toBe('2026-04-19');
  });

  it('04:59 JST はまだ前放送日', () => {
    const now = new Date('2026-04-19T04:59:00+09:00');
    expect(jstTodayYmd(now)).toBe('2026-04-18');
  });

  it('月末の深夜帯は前月末を返す', () => {
    const now = new Date('2026-05-01T03:00:00+09:00');
    expect(jstTodayYmd(now)).toBe('2026-04-30');
  });

  it('年末 1/1 03:00 JST は 12/31 を返す', () => {
    const now = new Date('2026-01-01T03:00:00+09:00');
    expect(jstTodayYmd(now)).toBe('2025-12-31');
  });
});

describe('addDays', () => {
  it('通常の加算', () => {
    expect(addDays('2026-04-19', 1)).toBe('2026-04-20');
    expect(addDays('2026-04-19', 7)).toBe('2026-04-26');
  });

  it('月跨ぎ', () => {
    expect(addDays('2026-04-30', 1)).toBe('2026-05-01');
  });

  it('年跨ぎ', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
  });

  it('うるう年 2/28 → 2/29', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
  });

  it('負の値で過去方向へも進める', () => {
    expect(addDays('2026-04-19', -1)).toBe('2026-04-18');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('0 は同日を返す', () => {
    expect(addDays('2026-04-19', 0)).toBe('2026-04-19');
  });
});
