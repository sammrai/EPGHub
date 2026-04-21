// Integration test for recordingService.update(). Verifies the pg-boss
// re-queue behaviour when margin fields change: old RECORD_START /
// RECORD_STOP jobs must be cancelled and new ones enqueued at the shifted
// startAfter timestamps. Mirrors the previous reserveService.update()
// behaviour from the R0 refactor.
//
// Gated on DATABASE_URL — skipped automatically if unset so the unit
// suite still runs bare.
//
// Run: `npm run test:recording-service`
import 'dotenv/config';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';

describe('recordingService.update() pg-boss re-queue', { concurrency: false }, () => {
  after(() => {
    // Force-exit: drizzle pool + pg-boss keep long-lived handles that
    // prevent Node from exiting naturally. Same pattern as
    // recorder.lifecycle.test.ts.
    setTimeout(() => process.exit(0), 200).unref();
  });

  test('marginPre / marginPost change cancels + re-queues RECORD_START / RECORD_STOP', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set');
      return;
    }

    const { db } = await import('../db/client.ts');
    const { recordings } = await import('../db/schema.ts');
    const { boss, QUEUE } = await import('../jobs/queue.ts');
    const { recordingService } = await import('./recordingService.ts');

    // pg-boss needs start() before send/cancel can operate. Idempotent.
    await boss.start();

    const id = 'rec_test_' + randomUUID();
    const programId = 'test-' + randomUUID();
    const now = Date.now();
    const startAt = new Date(now + 60 * 60_000); // +1h
    const endAt = new Date(now + 120 * 60_000); // +2h
    const initialMarginPre = 30;
    const initialMarginPost = 30;

    try {
      await db.insert(recordings).values({
        id,
        programId,
        ch: 'test-ch',
        title: 'recordingService.test',
        startAt,
        endAt,
        state: 'scheduled',
        priority: 'medium',
        quality: '1080i',
        keepRaw: false,
        marginPre: initialMarginPre,
        marginPost: initialMarginPost,
      });

      // Seed initial RECORD_START / RECORD_STOP jobs so update() has
      // something to cancel. Use the same startAfter math as the real
      // create() path: startAt - marginPre*1000 / endAt + marginPost*1000.
      const initialStartJobAt = new Date(startAt.getTime() - initialMarginPre * 1000);
      const initialStopJobAt = new Date(endAt.getTime() + initialMarginPost * 1000);
      const initialStartJobId = await boss.send(
        QUEUE.RECORD_START,
        { recordingId: id },
        { startAfter: initialStartJobAt }
      );
      const initialStopJobId = await boss.send(
        QUEUE.RECORD_STOP,
        { recordingId: id },
        { startAfter: initialStopJobAt }
      );
      assert.ok(initialStartJobId, 'seed RECORD_START job id should be returned');
      assert.ok(initialStopJobId, 'seed RECORD_STOP job id should be returned');

      // Snapshot the initial pending jobs. Guard against prior leftover
      // rows for the same id by filtering on job id.
      const before = (await db.execute<{ id: string; name: string; start_after: Date; state: string }>(
        sql`select id, name, start_after, state
              from pgboss.job
             where name in (${QUEUE.RECORD_START}, ${QUEUE.RECORD_STOP})
               and data->>'recordingId' = ${id}
               and state in ('created','retry')`
      )) as unknown as Array<{ id: string; name: string; start_after: Date; state: string }>;
      assert.ok(
        before.length >= 2,
        `expected >=2 pending seed jobs, got ${before.length}`
      );
      const beforeIds = new Set(before.map((r) => r.id));

      // --- Act: shift margins. update() should cancel both and enqueue
      // two new jobs with adjusted startAfter.
      const newMarginPre = 120;
      const newMarginPost = 120;
      const updated = await recordingService.update(id, {
        marginPre: newMarginPre,
        marginPost: newMarginPost,
      });
      assert.equal(updated.marginPre, newMarginPre);
      assert.equal(updated.marginPost, newMarginPost);

      // --- Assert: old jobs are no longer in created/retry.
      const oldStillPending = (await db.execute<{ id: string; state: string }>(
        sql`select id, state
              from pgboss.job
             where id in (${sql.join(Array.from(beforeIds).map((x) => sql`${x}`), sql`, `)})
               and state in ('created','retry')`
      )) as unknown as Array<{ id: string; state: string }>;
      assert.equal(
        oldStillPending.length,
        0,
        `old jobs should be cancelled, but still pending: ${JSON.stringify(oldStillPending)}`
      );

      // --- Assert: new jobs exist with the shifted startAfter.
      const after = (await db.execute<{ id: string; name: string; start_after: Date; state: string }>(
        sql`select id, name, start_after, state
              from pgboss.job
             where name in (${QUEUE.RECORD_START}, ${QUEUE.RECORD_STOP})
               and data->>'recordingId' = ${id}
               and state in ('created','retry')`
      )) as unknown as Array<{ id: string; name: string; start_after: Date; state: string }>;

      const newStart = after.find((r) => r.name === QUEUE.RECORD_START);
      const newStop = after.find((r) => r.name === QUEUE.RECORD_STOP);
      assert.ok(newStart, 'a new pending RECORD_START job should exist');
      assert.ok(newStop, 'a new pending RECORD_STOP job should exist');
      assert.ok(
        !beforeIds.has(newStart!.id),
        'new RECORD_START job should have a fresh id'
      );
      assert.ok(
        !beforeIds.has(newStop!.id),
        'new RECORD_STOP job should have a fresh id'
      );

      const expectedStartMs = startAt.getTime() - newMarginPre * 1000;
      const expectedStopMs = endAt.getTime() + newMarginPost * 1000;
      const gotStartMs = new Date(newStart!.start_after).getTime();
      const gotStopMs = new Date(newStop!.start_after).getTime();
      assert.ok(
        Math.abs(gotStartMs - expectedStartMs) < 2000,
        `new RECORD_START start_after=${newStart!.start_after} expected ≈ ${new Date(expectedStartMs).toISOString()}`
      );
      assert.ok(
        Math.abs(gotStopMs - expectedStopMs) < 2000,
        `new RECORD_STOP start_after=${newStop!.start_after} expected ≈ ${new Date(expectedStopMs).toISOString()}`
      );
    } finally {
      // Cleanup: cancel any lingering jobs for this id, then delete row.
      try {
        const pending = (await db.execute<{ id: string; name: string }>(
          sql`select id, name from pgboss.job
                where name in (${QUEUE.RECORD_START}, ${QUEUE.RECORD_STOP})
                  and state in ('created','retry')
                  and data->>'recordingId' = ${id}`
        )) as unknown as Array<{ id: string; name: string }>;
        for (const r of pending) await boss.cancel(r.name, r.id).catch(() => undefined);
      } catch {
        /* swallow */
      }
      await db.delete(recordings).where(eq(recordings.id, id)).catch(() => undefined);
    }
  });

  test('update without margin change does NOT cancel / re-queue jobs', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set');
      return;
    }

    const { db } = await import('../db/client.ts');
    const { recordings } = await import('../db/schema.ts');
    const { boss, QUEUE } = await import('../jobs/queue.ts');
    const { recordingService } = await import('./recordingService.ts');

    await boss.start();

    const id = 'rec_test_' + randomUUID();
    const programId = 'test-' + randomUUID();
    const now = Date.now();
    const startAt = new Date(now + 60 * 60_000);
    const endAt = new Date(now + 120 * 60_000);
    const marginPre = 30;
    const marginPost = 30;

    try {
      await db.insert(recordings).values({
        id,
        programId,
        ch: 'test-ch',
        title: 'recordingService.test.nochange',
        startAt,
        endAt,
        state: 'scheduled',
        priority: 'medium',
        quality: '1080i',
        keepRaw: false,
        marginPre,
        marginPost,
      });

      const startJobAt = new Date(startAt.getTime() - marginPre * 1000);
      const stopJobAt = new Date(endAt.getTime() + marginPost * 1000);
      await boss.send(QUEUE.RECORD_START, { recordingId: id }, { startAfter: startJobAt });
      await boss.send(QUEUE.RECORD_STOP, { recordingId: id }, { startAfter: stopJobAt });

      const before = (await db.execute<{ id: string; start_after: Date }>(
        sql`select id, start_after from pgboss.job
              where name in (${QUEUE.RECORD_START}, ${QUEUE.RECORD_STOP})
                and data->>'recordingId' = ${id}
                and state in ('created','retry')
             order by id`
      )) as unknown as Array<{ id: string; start_after: Date }>;
      assert.equal(before.length, 2, 'should have two pending seed jobs');
      const beforeIds = before.map((r) => r.id).sort();

      // --- Act: change priority only. marginPre/marginPost omitted ⇒ no
      // re-queue branch.
      const updated = await recordingService.update(id, { priority: 'high' });
      assert.equal(updated.priority, 'high');

      const after = (await db.execute<{ id: string; start_after: Date }>(
        sql`select id, start_after from pgboss.job
              where name in (${QUEUE.RECORD_START}, ${QUEUE.RECORD_STOP})
                and data->>'recordingId' = ${id}
                and state in ('created','retry')
             order by id`
      )) as unknown as Array<{ id: string; start_after: Date }>;
      const afterIds = after.map((r) => r.id).sort();
      assert.deepEqual(
        afterIds,
        beforeIds,
        'pending job ids should be unchanged when margin does not shift'
      );
      // start_after should also be untouched.
      for (let i = 0; i < before.length; i++) {
        assert.equal(
          new Date(before[i].start_after).getTime(),
          new Date(after[i].start_after).getTime(),
          'start_after should be unchanged'
        );
      }
    } finally {
      try {
        const pending = (await db.execute<{ id: string; name: string }>(
          sql`select id, name from pgboss.job
                where name in (${QUEUE.RECORD_START}, ${QUEUE.RECORD_STOP})
                  and state in ('created','retry')
                  and data->>'recordingId' = ${id}`
        )) as unknown as Array<{ id: string; name: string }>;
        for (const r of pending) await boss.cancel(r.name, r.id).catch(() => undefined);
      } catch {
        /* swallow */
      }
      await db.delete(recordings).where(eq(recordings.id, id)).catch(() => undefined);
    }
  });

  test('update on non-scheduled row does not crash (route enforces state, not service)', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set');
      return;
    }

    const { db } = await import('../db/client.ts');
    const { recordings } = await import('../db/schema.ts');
    const { boss } = await import('../jobs/queue.ts');
    const { recordingService } = await import('./recordingService.ts');

    await boss.start();

    const id = 'rec_test_' + randomUUID();
    const programId = 'test-' + randomUUID();
    const now = Date.now();
    const startAt = new Date(now + 60 * 60_000);
    const endAt = new Date(now + 120 * 60_000);

    try {
      // Insert with state='recording' — the re-queue branch has a
      // row.state === 'scheduled' guard, so it should be a no-op on
      // pg-boss but still update the row fields.
      await db.insert(recordings).values({
        id,
        programId,
        ch: 'test-ch',
        title: 'recordingService.test.nonscheduled',
        startAt,
        endAt,
        state: 'recording',
        priority: 'medium',
        quality: '1080i',
        keepRaw: false,
        marginPre: 30,
        marginPost: 30,
      });

      const updated = await recordingService.update(id, {
        marginPre: 90,
        marginPost: 90,
      });
      assert.equal(updated.state, 'recording', 'state should be preserved');
      assert.equal(updated.marginPre, 90);
      assert.equal(updated.marginPost, 90);
    } finally {
      await db.delete(recordings).where(eq(recordings.id, id)).catch(() => undefined);
    }
  });
});
