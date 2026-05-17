import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCache } from './fileCache.ts';

describe('FileCache — per-entry TTL override', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fcache-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('default TTL applies when set called without options', async () => {
    const cache = new FileCache(dir, 1_000);
    await cache.set('default-ttl', { v: 1 });
    assert.deepEqual(await cache.get('default-ttl'), { v: 1 });
  });

  test('per-entry ttlMs override is respected on get', async () => {
    // Default TTL is huge, but per-entry override is tiny → entry expires fast.
    const cache = new FileCache(dir, 60 * 60 * 1000);
    await cache.set('short', { v: 2 }, { ttlMs: 10 });
    // Read immediately — fresh.
    assert.deepEqual(await cache.get('short'), { v: 2 });
    // Wait past the per-entry TTL.
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Default 1h TTL would still consider it fresh, but the per-entry 10ms TTL wins.
    assert.equal(await cache.get('short'), null);
  });

  test('per-entry ttlMs of 0 invalidates immediately', async () => {
    const cache = new FileCache(dir, 60 * 60 * 1000);
    await cache.set('zero', { v: 3 }, { ttlMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await cache.get('zero'), null);
  });

  test('long per-entry TTL outlives a short default TTL', async () => {
    // Default 10ms, but per-entry says 1h — entry stays fresh past default.
    const cache = new FileCache(dir, 10);
    await cache.set('long', { v: 4 }, { ttlMs: 60 * 60 * 1000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await cache.get('long'), { v: 4 });
  });
});
