import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u } from './parser.ts';

describe('parseM3u', () => {
  test('happy path: multiple entries', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="nhk-g" tvg-name="NHK総合" group-title="GR",NHK総合',
      'http://iptv.example.com/nhk-g',
      '#EXTINF:-1 tvg-id="ex" tvg-name="テレビ朝日" group-title="GR",テレビ朝日',
      'http://iptv.example.com/ex',
      '#EXTINF:-1 tvg-id="bs-tbs" group-title="BS",BS-TBS',
      'http://iptv.example.com/bs-tbs',
    ].join('\n');
    const entries = parseM3u(text);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].tvgId, 'nhk-g');
    assert.equal(entries[0].tvgName, 'NHK総合');
    assert.equal(entries[0].groupTitle, 'GR');
    assert.equal(entries[0].name, 'NHK総合');
    assert.equal(entries[0].streamUrl, 'http://iptv.example.com/nhk-g');
    assert.equal(entries[2].groupTitle, 'BS');
    assert.equal(entries[2].tvgId, 'bs-tbs');
  });

  test('entry with all attributes', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="bs01" tvg-name="BS-TBS" tvg-logo="http://logo/bs01.png" group-title="BS" tvg-chno="161",BS-TBS',
      'http://example.com/stream/bs-tbs',
    ].join('\n');
    const entries = parseM3u(text);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.tvgId, 'bs01');
    assert.equal(e.tvgName, 'BS-TBS');
    assert.equal(e.tvgLogo, 'http://logo/bs01.png');
    assert.equal(e.groupTitle, 'BS');
    assert.equal(e.channelNumber, '161');
    assert.equal(e.name, 'BS-TBS');
    assert.equal(e.streamUrl, 'http://example.com/stream/bs-tbs');
  });

  test('entry with no attributes (name + url only)', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1,LocalCam',
      'http://cam.local/ch1',
    ].join('\n');
    const entries = parseM3u(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'LocalCam');
    assert.equal(entries[0].streamUrl, 'http://cam.local/ch1');
    assert.equal(entries[0].tvgId, undefined);
    assert.equal(entries[0].groupTitle, undefined);
  });

  test('group-title splits multiple', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="GR",Ch A',
      'http://a',
      '#EXTINF:-1 group-title="BS",Ch B',
      'http://b',
      '#EXTINF:-1 group-title="BS",Ch C',
      'http://c',
    ].join('\n');
    const entries = parseM3u(text);
    assert.equal(entries.length, 3);
    const byGroup: Record<string, number> = {};
    for (const e of entries) byGroup[e.groupTitle ?? ''] = (byGroup[e.groupTitle ?? ''] ?? 0) + 1;
    assert.equal(byGroup['GR'], 1);
    assert.equal(byGroup['BS'], 2);
  });

  test('CRLF line endings', () => {
    const text = '#EXTM3U\r\n#EXTINF:-1 tvg-id="x",X\r\nhttp://x\r\n';
    const entries = parseM3u(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tvgId, 'x');
    assert.equal(entries[0].name, 'X');
    assert.equal(entries[0].streamUrl, 'http://x');
  });

  test('empty input', () => {
    assert.deepEqual(parseM3u(''), []);
    assert.deepEqual(parseM3u('\n\n\n'), []);
  });

  test('malformed: no #EXTM3U header still parses', () => {
    const text = [
      '#EXTINF:-1 tvg-id="a",A',
      'http://a',
    ].join('\n');
    const entries = parseM3u(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tvgId, 'a');
    assert.equal(entries[0].name, 'A');
  });

  test('whitespace-only / trailing newline', () => {
    const text = '   \n#EXTM3U\n\n   \n#EXTINF:-1,Z\n   http://z   \n\n';
    const entries = parseM3u(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'Z');
    assert.equal(entries[0].streamUrl, 'http://z');
  });

  test('tolerates #EXTVLCOPT between EXTINF and URL', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="a",A',
      '#EXTVLCOPT:http-user-agent=foo',
      'http://a',
    ].join('\n');
    const entries = parseM3u(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].streamUrl, 'http://a');
  });

  test('orphan URL lines are dropped', () => {
    const text = [
      '#EXTM3U',
      'http://orphan',
      '#EXTINF:-1,real',
      'http://real',
    ].join('\n');
    const entries = parseM3u(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].streamUrl, 'http://real');
  });
});
