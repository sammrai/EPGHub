import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXmltv, xmltvTimeToIso } from './parser.ts';

test('xmltvTimeToIso: full timestamp with offset', () => {
  assert.equal(xmltvTimeToIso('20260421063000 +0900'), '2026-04-21T06:30:00+09:00');
});

test('xmltvTimeToIso: negative offset', () => {
  assert.equal(xmltvTimeToIso('20260421063000 -0500'), '2026-04-21T06:30:00-05:00');
});

test('xmltvTimeToIso: no seconds', () => {
  assert.equal(xmltvTimeToIso('202604210630 +0900'), '2026-04-21T06:30:00+09:00');
});

test('xmltvTimeToIso: no offset defaults to UTC', () => {
  assert.equal(xmltvTimeToIso('20260421063000'), '2026-04-21T06:30:00+00:00');
});

test('xmltvTimeToIso: invalid throws', () => {
  assert.throws(() => xmltvTimeToIso('not-a-date'));
});

test('parseXmltv: channels + programmes basic', () => {
  const xml = `<?xml version="1.0"?>
    <tv>
      <channel id="ch1.jp">
        <display-name>NHK総合</display-name>
        <display-name lang="en">NHK G</display-name>
      </channel>
      <channel id="ch2.jp">
        <display-name>Eテレ</display-name>
      </channel>
      <programme start="20260421060000 +0900" stop="20260421063000 +0900" channel="ch1.jp">
        <title lang="ja">ニュース</title>
        <sub-title>今日の特集</sub-title>
        <desc>朝のニュース</desc>
        <category>報道</category>
        <category>情報</category>
      </programme>
      <programme start="20260421063000 +0900" stop="20260421070000 +0900" channel="ch1.jp">
        <title>ドラマ</title>
      </programme>
    </tv>`;
  const r = parseXmltv(xml);
  assert.deepEqual(r.channels, [
    { id: 'ch1.jp', displayName: 'NHK総合' },
    { id: 'ch2.jp', displayName: 'Eテレ' },
  ]);
  assert.equal(r.programmes.length, 2);
  assert.deepEqual(r.programmes[0], {
    channelId: 'ch1.jp',
    startAt: '2026-04-21T06:00:00+09:00',
    endAt: '2026-04-21T06:30:00+09:00',
    title: 'ニュース',
    subTitle: '今日の特集',
    desc: '朝のニュース',
    categories: ['報道', '情報'],
  });
  assert.equal(r.programmes[1].title, 'ドラマ');
  assert.equal(r.programmes[1].desc, null);
  assert.equal(r.programmes[1].subTitle, null);
  assert.deepEqual(r.programmes[1].categories, []);
});

test('parseXmltv: missing tv root returns empty', () => {
  const r = parseXmltv('<root><foo/></root>');
  assert.deepEqual(r, { channels: [], programmes: [] });
});

test('parseXmltv: skips programmes without title or times', () => {
  const xml = `<tv>
    <programme start="20260421060000 +0900" stop="20260421063000 +0900" channel="x"></programme>
    <programme start="" stop="" channel="x"><title>t</title></programme>
    <programme start="20260421060000 +0900" stop="20260421063000 +0900" channel="x"><title>ok</title></programme>
  </tv>`;
  const r = parseXmltv(xml);
  assert.equal(r.programmes.length, 1);
  assert.equal(r.programmes[0].title, 'ok');
});

test('parseXmltv: single programme (fast-xml-parser returns object not array)', () => {
  const xml = `<tv>
    <channel id="c1"><display-name>C1</display-name></channel>
    <programme start="20260421060000 +0900" stop="20260421063000 +0900" channel="c1">
      <title>only one</title>
    </programme>
  </tv>`;
  const r = parseXmltv(xml);
  assert.equal(r.channels.length, 1);
  assert.equal(r.programmes.length, 1);
  assert.equal(r.programmes[0].title, 'only one');
});
