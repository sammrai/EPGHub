import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDiscoverUrl, parseDiscover } from './discover.ts';

test('deriveDiscoverUrl: base path without trailing slash', () => {
  assert.equal(
    deriveDiscoverUrl('http://h:40772/api/iptv'),
    'http://h:40772/api/iptv/discover.json'
  );
});

test('deriveDiscoverUrl: base path with trailing slash', () => {
  assert.equal(
    deriveDiscoverUrl('http://h:40772/api/iptv/'),
    'http://h:40772/api/iptv/discover.json'
  );
});

test('deriveDiscoverUrl: strips filename with extension', () => {
  // URL normalization strips the default HTTP port (:80) so we can't use it
  // in test fixtures — pick a non-default port for the explicit-port case.
  assert.equal(
    deriveDiscoverUrl('http://h:8080/iptv/playlist.m3u'),
    'http://h:8080/iptv/discover.json'
  );
  assert.equal(
    deriveDiscoverUrl('http://h/playlist.m3u8'),
    'http://h/discover.json'
  );
});

test('deriveDiscoverUrl: drops query + hash', () => {
  assert.equal(
    deriveDiscoverUrl('http://h:40772/api/iptv?token=x#frag'),
    'http://h:40772/api/iptv/discover.json'
  );
});

test('parseDiscover: Mirakurun-like payload', () => {
  const r = parseDiscover(JSON.stringify({
    FriendlyName: 'Mirakurun',
    Manufacturer: 'Mirakurun',
    ModelNumber: 'HDTC-2US',
    FirmwareVersion: '3.9.0',
    DeviceID: 'A1B2C3D4',
    TunerCount: 8,
    LineupURL: 'http://h:40772/api/iptv/lineup.json',
  }));
  assert.equal(r.friendlyName, 'Mirakurun');
  assert.equal(r.modelNumber, 'HDTC-2US');
  assert.equal(r.deviceId, 'A1B2C3D4');
  assert.equal(r.tunerCount, 8);
  assert.equal(r.lineupUrl, 'http://h:40772/api/iptv/lineup.json');
});

test('parseDiscover: string TunerCount coerced to int', () => {
  const r = parseDiscover('{"TunerCount":"4"}');
  assert.equal(r.tunerCount, 4);
});

test('parseDiscover: empty / invalid JSON → all nulls', () => {
  const empty = parseDiscover('');
  assert.equal(empty.friendlyName, null);
  assert.equal(empty.tunerCount, null);
  const bad = parseDiscover('not-json');
  assert.equal(bad.friendlyName, null);
});
