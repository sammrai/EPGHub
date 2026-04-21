import { describe, expect, it } from 'vitest';
import type {
  ApiNowRecording,
  ApiProgram,
  ApiRecording,
  ApiTunerState,
} from '../api/epghub';
import {
  hhmm,
  jpAirDate,
  reservedProgramIds,
  toNowRecording,
  toProgram,
  toRecording,
  tunersToUi,
} from './adapters';

const GENRE = { key: 'drama', label: 'ドラマ', dot: '#f00' } as const;

describe('hhmm', () => {
  it('Z 表記と +09:00 表記で同じ JST 時刻に正規化される', () => {
    // 2026-04-19T11:00Z === 2026-04-19T20:00+09:00
    expect(hhmm('2026-04-19T11:00:00Z')).toBe('20:00');
    expect(hhmm('2026-04-19T20:00:00+09:00')).toBe('20:00');
  });

  it('一桁の時/分は zero-pad される', () => {
    expect(hhmm('2026-04-19T00:05:00+09:00')).toBe('00:05');
  });
});

describe('jpAirDate', () => {
  it('YYYY/MM/DD (曜日) HH:MM 形式で返す', () => {
    // 2026-04-21 は火曜日
    expect(jpAirDate('2026-04-21T05:00:00+09:00')).toBe('2026/04/21 (火) 05:00');
  });

  it('日曜日は (日) を返す', () => {
    // 2026-04-19 は日曜日
    expect(jpAirDate('2026-04-19T20:00:00+09:00')).toBe('2026/04/19 (日) 20:00');
  });
});

const PROGRAM_BASE: ApiProgram = {
  id: 'nhk-g_2026-04-19T20:00',
  ch: 'nhk-g',
  startAt: '2026-04-19T20:00:00+09:00',
  endAt: '2026-04-19T20:45:00+09:00',
  title: '風の群像',
  genre: GENRE,
  ep: '#16',
  series: 'taiga-2026',
};

describe('toProgram', () => {
  it('reservedProgramIds に含まれなければ rec=false / recording=false', () => {
    const reserved = new Set<string>();
    const now = new Date('2026-04-19T20:30:00+09:00');
    const out = toProgram(PROGRAM_BASE, reserved, now);
    expect(out.rec).toBe(false);
    expect(out.recording).toBe(false);
  });

  it('reservedProgramIds に含まれ、now が放送中区間なら recording=true', () => {
    const reserved = new Set([PROGRAM_BASE.id]);
    const now = new Date('2026-04-19T20:30:00+09:00');
    const out = toProgram(PROGRAM_BASE, reserved, now);
    expect(out.rec).toBe(true);
    expect(out.recording).toBe(true);
  });

  it('予約済だが放送時間より前なら rec=true かつ recording=false', () => {
    const reserved = new Set([PROGRAM_BASE.id]);
    const now = new Date('2026-04-19T19:00:00+09:00');
    const out = toProgram(PROGRAM_BASE, reserved, now);
    expect(out.rec).toBe(true);
    expect(out.recording).toBe(false);
  });

  it('予約済だが放送終了後なら recording=false', () => {
    const reserved = new Set([PROGRAM_BASE.id]);
    const now = new Date('2026-04-19T21:00:00+09:00');
    const out = toProgram(PROGRAM_BASE, reserved, now);
    expect(out.rec).toBe(true);
    expect(out.recording).toBe(false);
  });

  it('終了時刻ちょうどは recording=false (endMs > nowMs が厳密)', () => {
    const reserved = new Set([PROGRAM_BASE.id]);
    const now = new Date('2026-04-19T20:45:00+09:00');
    const out = toProgram(PROGRAM_BASE, reserved, now);
    expect(out.recording).toBe(false);
  });

  it('ISO と HH:MM をそれぞれ保持する', () => {
    const out = toProgram(PROGRAM_BASE, new Set(), new Date());
    expect(out.start).toBe('20:00');
    expect(out.end).toBe('20:45');
    expect(out.startAt).toBe('2026-04-19T20:00:00+09:00');
    expect(out.endAt).toBe('2026-04-19T20:45:00+09:00');
  });

  it('optional フィールドの undefined は null に正規化される', () => {
    const out = toProgram(PROGRAM_BASE, new Set(), new Date());
    expect(out.tvdb).toBeNull();
    expect(out.extended).toBeNull();
    expect(out.video).toBeNull();
    expect(out.tvdbSeason).toBeNull();
    expect(out.tvdbEpisode).toBeNull();
    expect(out.tvdbEpisodeName).toBeNull();
  });
});

const RECORDING_BASE: ApiRecording = {
  id: 'rec_01HX',
  programId: 'nhk-g_2026-04-19T20:00',
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
  state: 'scheduled',
};

describe('reservedProgramIds', () => {
  it('scheduled / recording / encoding / conflict は含む', () => {
    const recs: ApiRecording[] = [
      { ...RECORDING_BASE, id: 'r1', programId: 'p1', state: 'scheduled' },
      { ...RECORDING_BASE, id: 'r2', programId: 'p2', state: 'recording' },
      { ...RECORDING_BASE, id: 'r3', programId: 'p3', state: 'encoding' },
      { ...RECORDING_BASE, id: 'r4', programId: 'p4', state: 'conflict' },
    ];
    const set = reservedProgramIds(recs);
    expect(set.size).toBe(4);
    expect(set.has('p1')).toBe(true);
    expect(set.has('p2')).toBe(true);
    expect(set.has('p3')).toBe(true);
    expect(set.has('p4')).toBe(true);
  });

  it('ready / failed は除外される (ライブラリ側の扱い)', () => {
    const recs: ApiRecording[] = [
      { ...RECORDING_BASE, id: 'r1', programId: 'p-ready', state: 'ready' },
      { ...RECORDING_BASE, id: 'r2', programId: 'p-failed', state: 'failed' },
      { ...RECORDING_BASE, id: 'r3', programId: 'p-scheduled', state: 'scheduled' },
    ];
    const set = reservedProgramIds(recs);
    expect(set.has('p-ready')).toBe(false);
    expect(set.has('p-failed')).toBe(false);
    expect(set.has('p-scheduled')).toBe(true);
  });

  it('空配列', () => {
    expect(reservedProgramIds([]).size).toBe(0);
  });
});

describe('toRecording', () => {
  it('nullable の未指定フィールドが空文字 / 0 / false / null に正規化される', () => {
    const out = toRecording(RECORDING_BASE);
    expect(out.filename).toBe('');
    expect(out.thumb).toBe('');
    expect(out.size).toBe(0);
    expect(out.duration).toBe(0);
    expect(out.air).toBe(''); // recordedAt 無し
    expect(out.tvdbId).toBeNull();
    expect(out.series).toBeNull();
    expect(out.season).toBeNull();
    expect(out.ep).toBeNull();
    expect(out.epTitle).toBeNull();
    expect(out.ruleMatched).toBeNull();
    expect(out.encodePreset).toBeNull();
    expect(out.encodeError).toBeNull();
    expect(out.originalStartAt).toBeNull();
    expect(out.originalEndAt).toBeNull();
    expect(out.new).toBe(false);
  });

  it('recordedAt があれば JST 日付文字列が air に入る', () => {
    const out = toRecording({
      ...RECORDING_BASE,
      recordedAt: '2026-04-21T05:00:00+09:00',
    });
    expect(out.air).toBe('2026/04/21 (火) 05:00');
  });

  it('result フィールドがそろっていればそのまま反映される', () => {
    const out = toRecording({
      ...RECORDING_BASE,
      state: 'ready',
      filename: 'out.mp4',
      size: 12.5,
      duration: 45,
      thumb: '/thumb.jpg',
      tvdbId: 389042,
      season: 1,
      ep: 16,
      epTitle: '運命の秋',
      new: true,
    });
    expect(out.filename).toBe('out.mp4');
    expect(out.size).toBe(12.5);
    expect(out.duration).toBe(45);
    expect(out.thumb).toBe('/thumb.jpg');
    expect(out.tvdbId).toBe(389042);
    expect(out.season).toBe(1);
    expect(out.ep).toBe(16);
    expect(out.epTitle).toBe('運命の秋');
    expect(out.new).toBe(true);
  });
});

describe('toNowRecording', () => {
  it('start/end が HH:MM に整形される', () => {
    const n: ApiNowRecording = {
      id: 'rec_1',
      title: '風の群像',
      ch: 'nhk-g',
      startAt: '2026-04-19T20:00:00+09:00',
      endAt: '2026-04-19T20:45:00+09:00',
      progress: 0.4,
      series: 'taiga-2026',
      tvdbId: 389042,
    };
    const out = toNowRecording(n);
    expect(out.start).toBe('20:00');
    expect(out.end).toBe('20:45');
    expect(out.progress).toBe(0.4);
  });
});

describe('tunersToUi', () => {
  it('GR/BS/CS の total/inUse を平坦化', () => {
    const list: ApiTunerState[] = [
      { type: 'GR', total: 4, inUse: 2 },
      { type: 'BS', total: 2, inUse: 0 },
      { type: 'CS', total: 1, inUse: 1 },
    ];
    expect(tunersToUi(list)).toEqual({
      gr: { total: 4, inUse: 2 },
      bs: { total: 2, inUse: 0 },
      cs: { total: 1, inUse: 1 },
    });
  });

  it('欠けたタイプは total/inUse=0 で埋める', () => {
    const list: ApiTunerState[] = [{ type: 'GR', total: 4, inUse: 2 }];
    expect(tunersToUi(list)).toEqual({
      gr: { total: 4, inUse: 2 },
      bs: { total: 0, inUse: 0 },
      cs: { total: 0, inUse: 0 },
    });
  });

  it('空配列なら全て 0', () => {
    expect(tunersToUi([])).toEqual({
      gr: { total: 0, inUse: 0 },
      bs: { total: 0, inUse: 0 },
      cs: { total: 0, inUse: 0 },
    });
  });
});
