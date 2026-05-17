// Integration test for ruleService.update(): toggling enabled true→false
// must cascade-delete scheduled recordings the rule produced (parity with
// remove()). Skipped without DATABASE_URL so the unit-only suite still
// runs bare. Uses the live Postgres + pg-boss stack.
//
// Run: `node --import tsx --test src/services/ruleService.toggle.test.ts`
import 'dotenv/config';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';

describe('ruleService.update() — disable cascades scheduled reserves', { concurrency: false }, () => {
  after(() => {
    setTimeout(() => process.exit(0), 200).unref();
  });

  test('series rule toggle off deletes scheduled recordings sourced by it', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set');
      return;
    }

    const { db } = await import('../db/client.ts');
    const { rules, recordings, channels, programs, tvdbEntries } = await import('../db/schema.ts');
    const { ruleService } = await import('./ruleService.ts');
    const { boss } = await import('../jobs/queue.ts');
    await boss.start();

    const tvdbId = 999_990_000 + Math.floor(Math.random() * 9999);
    const chId = 'test-ch-' + randomUUID().slice(0, 8);
    const progIdSelf = `${chId}_2099-01-01T00:00:00.000Z`;
    const recIdSelf = 'rec_test_self_' + randomUUID();
    // A second recording on the same TVDB id sourced via sourceTvdbId
    // (the path series-rule expansion uses) — we want both branches of
    // the cascade exercised.
    const progIdSeries = `${chId}_2099-01-02T00:00:00.000Z`;
    const recIdSeries = 'rec_test_series_' + randomUUID();
    let ruleId: number | null = null;

    try {
      // Seed: channel, two programs, a tvdb_entries row, the rule itself,
      // and two scheduled recordings — one sourced by sourceRuleId, the
      // other by sourceTvdbId. The series-rule expander writes the
      // latter; the legacy keyword expander writes the former.
      await db.insert(channels).values({
        id: chId,
        name: 'test channel',
        short: 'test',
        type: 'GR',
        number: '999',
        color: 'oklch(0.5 0.1 0)',
        enabled: true,
      });
      await db.insert(tvdbEntries).values({
        tvdbId,
        kind: 'series',
        title: 'rule-toggle-test',
        slug: 'rule-toggle-test-' + tvdbId,
        titleEn: 'rule-toggle-test',
        network: '',
        year: 2099,
        poster: '',
        matchedBy: 'manual',
        status: 'continuing',
        totalSeasons: 1,
        currentSeason: 1,
        currentEp: 1,
        totalEps: 12,
      });
      await db.insert(programs).values([
        {
          id: progIdSelf,
          ch: chId,
          startAt: new Date('2099-01-01T00:00:00.000Z'),
          endAt:   new Date('2099-01-01T00:30:00.000Z'),
          title: 'rule-toggle-test ep1',
          genreKey: 'anime',
        },
        {
          id: progIdSeries,
          ch: chId,
          startAt: new Date('2099-01-02T00:00:00.000Z'),
          endAt:   new Date('2099-01-02T00:30:00.000Z'),
          title: 'rule-toggle-test ep2',
          genreKey: 'anime',
        },
      ]);
      const [insertedRule] = await db
        .insert(rules)
        .values({
          name: 'rule-toggle-test',
          keyword: 'rule-toggle-test',
          channels: [chId],
          enabled: true,
          priority: 'medium',
          quality: '1080i',
          skipReruns: true,
          kind: 'series',
          tvdbId,
        })
        .returning({ id: rules.id });
      ruleId = insertedRule.id;

      await db.insert(recordings).values([
        {
          id: recIdSelf,
          programId: progIdSelf,
          ch: chId,
          title: 'rule-toggle-test ep1',
          startAt: new Date('2099-01-01T00:00:00.000Z'),
          endAt:   new Date('2099-01-01T00:30:00.000Z'),
          state: 'scheduled',
          priority: 'medium',
          quality: '1080i',
          keepRaw: false,
          marginPre: 0,
          marginPost: 30,
          sourceRuleId: ruleId,
        },
        {
          id: recIdSeries,
          programId: progIdSeries,
          ch: chId,
          title: 'rule-toggle-test ep2',
          startAt: new Date('2099-01-02T00:00:00.000Z'),
          endAt:   new Date('2099-01-02T00:30:00.000Z'),
          state: 'scheduled',
          priority: 'medium',
          quality: '1080i',
          keepRaw: false,
          marginPre: 0,
          marginPost: 30,
          sourceTvdbId: tvdbId,
        },
      ]);

      // Sanity: both recordings are present BEFORE toggle.
      const recsBefore = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(eq(recordings.ch, chId));
      assert.equal(recsBefore.length, 2, 'pre-toggle: 2 recordings should exist');

      // --- Act: toggle off ---
      const updated = await ruleService.update(ruleId, { enabled: false });
      assert.ok(updated, 'update() should return the patched rule');
      assert.equal(updated!.enabled, false, 'rule.enabled should be false after toggle');

      // --- Assert: BOTH recordings deleted ---
      const recsAfter = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(eq(recordings.ch, chId));
      assert.equal(
        recsAfter.length,
        0,
        `post-toggle: scheduled recordings should be cleared, still have ${recsAfter.map((r) => r.id).join(',')}`,
      );

      // --- Sanity: rule itself is still in the table (not removed) ---
      const stillThere = await db
        .select({ id: rules.id, enabled: rules.enabled })
        .from(rules)
        .where(eq(rules.id, ruleId));
      assert.equal(stillThere.length, 1, 'rule row must persist (toggle ≠ remove)');
      assert.equal(stillThere[0].enabled, false);
    } finally {
      // Cleanup in FK-safe order.
      await db.delete(recordings).where(eq(recordings.ch, chId)).catch(() => undefined);
      if (ruleId != null) {
        await db.delete(rules).where(eq(rules.id, ruleId)).catch(() => undefined);
      }
      await db.delete(programs).where(eq(programs.ch, chId)).catch(() => undefined);
      await db.delete(tvdbEntries).where(eq(tvdbEntries.tvdbId, tvdbId)).catch(() => undefined);
      await db.delete(channels).where(eq(channels.id, chId)).catch(() => undefined);
      void and; // (kept for potential future compound predicates)
    }
  });
});
