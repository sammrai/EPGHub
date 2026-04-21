// Unit tests for the Plex filename builder. Pure function → no fixtures,
// no temp dirs, no DB. Run: `npm run test:plex-naming`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { plexPath, sanitizeComponent, zeroPad2 } from './plexNaming.ts';

// A JST-consistent fixture timestamp. 2026-04-20 18:30 JST = 09:30Z.
// All series-fallback filenames should embed `20260420_1830`.
const ISO = '2026-04-20T09:30:00.000Z';

// Stable recording id — the last 8 chars land in noisy-case filenames.
const REC_ID = 'rec-abcdef-34567890';
const ID8 = '34567890';

describe('zeroPad2', () => {
  test('single-digit → two-digit', () => {
    assert.equal(zeroPad2(0), '00');
    assert.equal(zeroPad2(1), '01');
    assert.equal(zeroPad2(9), '09');
  });
  test('two-digit pass-through', () => {
    assert.equal(zeroPad2(10), '10');
    assert.equal(zeroPad2(99), '99');
  });
  test('three+ digits kept raw', () => {
    assert.equal(zeroPad2(100), '100');
    assert.equal(zeroPad2(1234), '1234');
  });
});

describe('sanitizeComponent', () => {
  test('replaces path-unsafe chars with _', () => {
    const input = 'a/b\\c:d*e?f"g<h>i|j';
    const out = sanitizeComponent(input);
    assert.equal(out, 'a_b_c_d_e_f_g_h_i_j');
  });

  test('replaces control chars with _', () => {
    const input = 'hello\x00\x01\x1fworld\x7f';
    const out = sanitizeComponent(input);
    assert.equal(out, 'hello___world_');
  });

  test('strips trailing space and dot', () => {
    assert.equal(sanitizeComponent('foo  '), 'foo');
    assert.equal(sanitizeComponent('foo..'), 'foo');
    assert.equal(sanitizeComponent('foo. '), 'foo');
    assert.equal(sanitizeComponent('foo . '), 'foo');
  });

  test('truncates to 100 chars', () => {
    const input = 'a'.repeat(200);
    const out = sanitizeComponent(input);
    assert.equal(out.length, 100);
    assert.equal(out, 'a'.repeat(100));
  });

  test('empty / whitespace-only input returns _', () => {
    assert.equal(sanitizeComponent(''), '_');
    assert.equal(sanitizeComponent('   '), '_');
    assert.equal(sanitizeComponent('.'), '_');
  });

  test('preserves non-ASCII (Japanese etc.)', () => {
    assert.equal(sanitizeComponent('アニメ'), 'アニメ');
  });
});

describe('plexPath — series', () => {
  test('full tuple (S + E + epName)', () => {
    const r = plexPath({
      title: 'Broadcast Title',
      startAtIso: ISO,
      tvdb: { kind: 'series', title: 'Title', year: 2020 },
      season: 2,
      episode: 14,
      episodeName: 'Episode Name',
      extension: 'mp4',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Shows/Title/Season 02');
    assert.equal(r.filename, 'Title - s02e14 - Episode Name.mp4');
    assert.equal(r.relPath, 'Shows/Title/Season 02/Title - s02e14 - Episode Name.mp4');
  });

  test('S + E without epName — adds id8 collision salt, no trailing dash-name', () => {
    const r = plexPath({
      title: 'Title',
      startAtIso: ISO,
      tvdb: { kind: 'series', title: 'Title', year: null },
      season: 2,
      episode: 14,
      episodeName: null,
      extension: 'mp4',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Shows/Title/Season 02');
    assert.equal(r.filename, `Title - s02e14_${ID8}.mp4`);
  });

  test('S present, E null → includes JST stamp + id8', () => {
    const r = plexPath({
      title: 'Title',
      startAtIso: ISO,
      tvdb: { kind: 'series', title: 'Title', year: null },
      season: 2,
      episode: null,
      episodeName: null,
      extension: 'ts',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Shows/Title/Season 02');
    assert.equal(r.filename, `Title - s02 - 20260420_1830_${ID8}.ts`);
  });

  test('specials S=0 → Season 00', () => {
    const r = plexPath({
      title: 'Title',
      startAtIso: ISO,
      tvdb: { kind: 'series', title: 'Title', year: null },
      season: 0,
      episode: 3,
      episodeName: 'Special',
      extension: 'mp4',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Shows/Title/Season 00');
    assert.equal(r.filename, 'Title - s00e03 - Special.mp4');
  });

  test('series, no S → defaults to Season 01 with timestamped filename', () => {
    const r = plexPath({
      title: 'Broadcast Title',
      startAtIso: ISO,
      tvdb: { kind: 'series', title: 'Title', year: null },
      season: null,
      episode: null,
      episodeName: null,
      extension: 'ts',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Shows/Title/Season 01');
    assert.equal(r.filename, `Title - 20260420_1830_${ID8}.ts`);
  });
});

describe('plexPath — movie', () => {
  test('movie with year', () => {
    const r = plexPath({
      title: 'Broadcast Title',
      startAtIso: ISO,
      tvdb: { kind: 'movie', title: 'Title', year: 2024 },
      season: null,
      episode: null,
      episodeName: null,
      extension: 'mp4',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Movies/Title (2024)');
    assert.equal(r.filename, `Title (2024)_${ID8}.mp4`);
  });

  test('movie without year', () => {
    const r = plexPath({
      title: 'Broadcast Title',
      startAtIso: ISO,
      tvdb: { kind: 'movie', title: 'Title', year: null },
      season: null,
      episode: null,
      episodeName: null,
      extension: 'mp4',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Movies/Title');
    assert.equal(r.filename, `Title_${ID8}.mp4`);
  });
});

describe('plexPath — unmatched (no tvdb, TV-show fallback)', () => {
  test('falls back to broadcast title under Shows/Season 01', () => {
    const r = plexPath({
      title: 'Broadcast Title',
      startAtIso: ISO,
      tvdb: null,
      season: null,
      episode: null,
      episodeName: null,
      extension: 'ts',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Shows/Broadcast Title/Season 01');
    assert.equal(r.filename, `Broadcast Title - 20260420_1830_${ID8}.ts`);
  });

  test('unsafe chars in broadcast title get sanitized in dir + filename', () => {
    const r = plexPath({
      title: 'A/B:C',
      startAtIso: ISO,
      tvdb: null,
      season: null,
      episode: null,
      episodeName: null,
      extension: 'ts',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Shows/A_B_C/Season 01');
    assert.equal(r.filename, `A_B_C - 20260420_1830_${ID8}.ts`);
  });
});

describe('plexPath — sanitization integration', () => {
  test('title with all path-unsafe chars becomes underscores in both parts', () => {
    const title = 'a/b\\c:d*e?f"g<h>i|j';
    const r = plexPath({
      title,
      startAtIso: ISO,
      tvdb: { kind: 'series', title, year: null },
      season: 1,
      episode: 1,
      episodeName: null,
      extension: 'mp4',
      recordingId: REC_ID,
    });
    assert.equal(r.dir, 'Shows/a_b_c_d_e_f_g_h_i_j/Season 01');
    assert.equal(r.filename, `a_b_c_d_e_f_g_h_i_j - s01e01_${ID8}.mp4`);
  });

  test('200-char title truncated to 100 in filename', () => {
    const longTitle = 'a'.repeat(200);
    const r = plexPath({
      title: longTitle,
      startAtIso: ISO,
      tvdb: { kind: 'series', title: longTitle, year: null },
      season: 1,
      episode: 1,
      episodeName: null,
      extension: 'mp4',
      recordingId: REC_ID,
    });
    // The title component (used in both dir + filename) is clamped.
    assert.ok(r.dir.startsWith('Shows/' + 'a'.repeat(100) + '/'));
    assert.equal(r.dir, `Shows/${'a'.repeat(100)}/Season 01`);
    assert.equal(r.filename, `${'a'.repeat(100)} - s01e01_${ID8}.mp4`);
  });
});
