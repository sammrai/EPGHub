// Integration tests for programs upserts and the failure mode that used to
// grow the heap by the size of the SQL text on every failed query.
//
// Run: `node --import tsx --test src/services/programService.test.ts`
import 'dotenv/config';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { eq } from 'drizzle-orm';
import type { Program } from '../schemas/program.ts';

const GENRE = { key: 'news', label: 'ニュース', dot: 'oklch(0.6 0.02 250)' } as Program['genre'];

function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

describe('programService', { concurrency: false }, () => {
  after(() => {
    setTimeout(() => process.exit(0), 200).unref();
  });

  test('upsertMany keeps the last row when a batch repeats an id', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set');
      return;
    }
    const { db } = await import('../db/client.ts');
    const { channels, programs } = await import('../db/schema.ts');
    const { programService } = await import('./programService.ts');

    const ch = 'test-ch-' + randomUUID().slice(0, 8);
    await db.insert(channels).values({ id: ch, name: 'test', short: 'test', type: 'GR', number: '1', color: '#000' });
    try {
      const id = `${ch}_2099-01-01T00:00:00.000Z`;
      const row = (title: string): Program => ({
        id,
        ch,
        startAt: '2099-01-01T00:00:00.000Z',
        endAt: '2099-01-01T01:00:00.000Z',
        title,
        genre: GENRE,
        ep: null,
        series: null,
        hd: true,
      });

      await programService.upsertMany([row('old event'), row('new event')]);

      const stored = await db.select().from(programs).where(eq(programs.id, id));
      assert.equal(stored.length, 1);
      assert.equal(stored[0].title, 'new event');
    } finally {
      await db.delete(channels).where(eq(channels.id, ch));
    }
  });

  test('failed queries do not retain their SQL text', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set');
      return;
    }
    const { queryClient } = await import('../db/client.ts');

    const FAILURES = 50;
    const failOnce = async () => {
      // A fresh buffer per call: a shared padding string would be retained
      // only once and hide the growth this test is looking for.
      const padding = Buffer.alloc(1024 * 1024, 'x').toString();
      await assert.rejects(queryClient.unsafe(`/* ${padding} */ select * from no_such_table`));
    };

    await failOnce();
    collectGarbage();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < FAILURES; i++) await failOnce();
    collectGarbage();
    const grownMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

    assert.ok(grownMb < FAILURES / 2, `heap grew ${grownMb.toFixed(1)}MB after ${FAILURES} failed 1MB queries`);
  });
});
