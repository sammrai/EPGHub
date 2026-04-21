import { describe, expect, it } from 'vitest';
import {
  broadcastDayAt,
  durLabel,
  durMin,
  findSeries,
  fromMin,
  getChannel,
  progId,
  seriesCounts,
  toMin,
} from './epg';
import type { Channel, Program, Recording, TvdbSeries } from '../data/types';

const GENRE = { key: 'drama', label: 'ドラマ', dot: '#f00' } as const;

function makeProgram(overrides: Partial<Program>): Program {
  return {
    ch: 'nhk-g',
    start: '20:00',
    end: '20:45',
    title: 'テスト番組',
    genre: GENRE,
    ep: null,
    series: null,
    ...overrides,
  };
}

describe('toMin / fromMin', () => {
  it('HH:MM → 分', () => {
    expect(toMin('00:00')).toBe(0);
    expect(toMin('01:30')).toBe(90);
    expect(toMin('23:59')).toBe(23 * 60 + 59);
  });

  it('分 → HH:MM (24h wrap)', () => {
    expect(fromMin(0)).toBe('00:00');
    expect(fromMin(90)).toBe('01:30');
    expect(fromMin(24 * 60)).toBe('00:00');
    expect(fromMin(25 * 60)).toBe('01:00');
    expect(fromMin(1500)).toBe('01:00'); // 1500 / 60 = 25h → 01:00
  });
});

describe('broadcastDayAt', () => {
  it('0h では同日', () => {
    expect(broadcastDayAt('2026-04-19', 0)).toBe('2026-04-19');
    expect(broadcastDayAt('2026-04-19', 12 * 60)).toBe('2026-04-19');
    expect(broadcastDayAt('2026-04-19', 23 * 60 + 59)).toBe('2026-04-19');
  });

  it('24h 以降は翌日', () => {
    expect(broadcastDayAt('2026-04-19', 24 * 60)).toBe('2026-04-20');
    expect(broadcastDayAt('2026-04-19', 25 * 60)).toBe('2026-04-20');
  });

  it('月跨ぎ', () => {
    expect(broadcastDayAt('2026-04-30', 24 * 60)).toBe('2026-05-01');
  });

  it('年跨ぎ', () => {
    expect(broadcastDayAt('2025-12-31', 24 * 60)).toBe('2026-01-01');
  });
});

describe('durMin', () => {
  it('ISO start/end があるときは ISO を優先', () => {
    const p = makeProgram({
      start: '20:00',
      end: '20:45',
      startAt: '2026-04-19T20:00:00+09:00',
      endAt: '2026-04-19T20:30:00+09:00',
    });
    expect(durMin(p)).toBe(30); // ISO: 30 min
  });

  it('ISO が無いときは HH:MM から算出', () => {
    expect(durMin(makeProgram({ start: '20:00', end: '20:45' }))).toBe(45);
  });

  it('HH:MM で深夜越え (end < start) は +24h 扱い', () => {
    expect(durMin(makeProgram({ start: '23:30', end: '00:30' }))).toBe(60);
  });

  it('負になるケースは返さない', () => {
    const d = durMin(makeProgram({ start: '23:30', end: '00:00' }));
    expect(d).toBeGreaterThanOrEqual(0);
  });
});

describe('durLabel', () => {
  it('分未満 60 はそのまま分', () => {
    expect(durLabel(makeProgram({ start: '20:00', end: '20:30' }))).toBe('30分');
  });

  it('ちょうど 1 時間', () => {
    expect(durLabel(makeProgram({ start: '20:00', end: '21:00' }))).toBe('1時間');
  });

  it('1 時間 30 分', () => {
    expect(durLabel(makeProgram({ start: '20:00', end: '21:30' }))).toBe('1時間30分');
  });
});

describe('getChannel', () => {
  const channels: Channel[] = [
    { id: 'nhk-g', name: 'NHK総合', short: 'NHK G', number: '011', type: 'GR', color: '#f00' },
    { id: 'ex', name: 'テレビ朝日', short: 'EX', number: '051', type: 'GR', color: '#0f0' },
  ];

  it('一致するIDを返す', () => {
    expect(getChannel(channels, 'ex')?.name).toBe('テレビ朝日');
  });

  it('一致しなければ undefined', () => {
    expect(getChannel(channels, 'missing')).toBeUndefined();
  });
});

describe('findSeries', () => {
  const programs: Program[] = [
    makeProgram({ title: 'A1', series: 'taiga-2026' }),
    makeProgram({ title: 'A2', series: 'taiga-2026' }),
    makeProgram({ title: 'B1', series: 'other' }),
    makeProgram({ title: 'X', series: null }),
  ];

  it('seriesKey が一致する番組だけ返す', () => {
    expect(findSeries(programs, 'taiga-2026').map((p) => p.title)).toEqual(['A1', 'A2']);
  });

  it('seriesKey が null のときは空配列', () => {
    expect(findSeries(programs, null)).toEqual([]);
  });
});

describe('progId', () => {
  it('p.id があるときはそれを使う', () => {
    expect(progId(makeProgram({ id: 'explicit-id' }))).toBe('explicit-id');
  });

  it('p.id が無ければ ch + startAt + title 先頭', () => {
    const p = makeProgram({
      ch: 'nhk-g',
      startAt: '2026-04-19T20:00:00+09:00',
      title: 'テスト番組',
    });
    expect(progId(p)).toBe('nhk-g-2026-04-19T20:00:00+09:00-テスト番組');
  });

  it('id も startAt も無ければ ch + start + title 先頭', () => {
    const p = makeProgram({ ch: 'nhk-g', start: '20:00', title: 'テスト番組' });
    expect(progId(p)).toBe('nhk-g-20:00-テスト番組');
  });
});

describe('seriesCounts', () => {
  const TVDB_ID = 389042;

  function makeTvdb(overrides: Partial<TvdbSeries> = {}): TvdbSeries {
    return {
      id: TVDB_ID,
      slug: 'kaze-no-gunzo',
      title: '風の群像',
      titleEn: 'Kaze',
      network: 'NHK',
      year: 2026,
      poster: '',
      matchedBy: 'search',
      type: 'series',
      status: 'continuing',
      totalSeasons: 0,
      currentSeason: 0,
      currentEp: 0,
      totalEps: 0,
      ...overrides,
    };
  }

  function makeRecording(overrides: Partial<Recording>): Recording {
    return {
      id: `rec_${Math.random().toString(36).slice(2)}`,
      programId: 'p1',
      ch: 'nhk-g',
      title: '風の群像',
      startAt: '2026-04-19T20:00:00+09:00',
      endAt: '2026-04-19T20:45:00+09:00',
      priority: 'medium',
      quality: 'hd',
      keepRaw: false,
      marginPre: 0,
      marginPost: 30,
      source: { kind: 'once' },
      state: 'ready',
      air: '',
      duration: 0,
      size: 0,
      filename: '',
      thumb: '',
      tvdbId: TVDB_ID,
      series: 'taiga-2026',
      season: null,
      ep: null,
      epTitle: null,
      ...overrides,
    };
  }

  it('TVDB 側が 0 のとき recordings からフォールバックし partial=true', () => {
    const tvdb = makeTvdb();
    const recs: Recording[] = [
      makeRecording({ season: 1, ep: 1 }),
      makeRecording({ season: 1, ep: 3 }),
      makeRecording({ season: 2, ep: 1 }),
    ];
    const out = seriesCounts(tvdb, recs);
    expect(out.partial).toBe(true);
    expect(out.totalEps).toBe(3); // recording 数
    expect(out.totalSeasons).toBe(2); // season 1 と 2
    expect(out.currentSeason).toBe(2);
    expect(out.currentEp).toBe(1); // season 2 の最大 ep
  });

  it('TVDB 側が埋まっていれば TVDB の値を優先', () => {
    const tvdb = makeTvdb({ totalEps: 50, totalSeasons: 3, currentEp: 5, currentSeason: 3 });
    const out = seriesCounts(tvdb, []);
    expect(out).toEqual({
      totalEps: 50,
      totalSeasons: 3,
      currentEp: 5,
      currentSeason: 3,
      partial: false,
    });
  });

  it('tvdbId が違う recording は除外される', () => {
    const tvdb = makeTvdb();
    const recs: Recording[] = [
      makeRecording({ season: 1, ep: 1 }),
      makeRecording({ tvdbId: 99999, season: 5, ep: 10 }), // 無関係
    ];
    const out = seriesCounts(tvdb, recs);
    expect(out.totalEps).toBe(1);
    expect(out.currentSeason).toBe(1);
  });
});
