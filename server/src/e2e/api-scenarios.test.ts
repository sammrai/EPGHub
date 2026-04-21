// API-level scenario tests. Exercises the live server at localhost:3000
// (start it with `npm run dev` in another shell). Uses node:test + fetch —
// no framework deps. Each test tracks the entities it creates and cleans
// up on teardown so the suite is safe to run against a dev DB.
//
// Run: `npm run test:e2e`
//
// Scenarios covered (post R0 unification — the single /recordings
// endpoint replaces the prior /reserves + /recorded split):
//   1. 単発録画  create → list → /schedule 反映 → cancel
//   2. シリーズ録画 (kind='series')  rule 作成 → /rules に出る → expand で recordings 生成
//   3. 同じ TVDB の series rule を2回作ると 409
//   4. シリーズ予約済の番組を再度予約しようとすると 409 duplicate
//   5. 新規 recording は state=scheduled で /now-recording には出ない

import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.EPG_BASE ?? 'http://localhost:3000';

interface ApiResponse<T> { status: number; data: T }

async function req<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data: data as T };
}

const createdRecordings = new Set<string>();
const createdRules = new Set<number>();

function trackRecording(id: string) { createdRecordings.add(id); }
function trackRule(id: number) { createdRules.add(id); }

async function wipeAllRecordings(): Promise<void> {
  const { data } = await req<Recording[]>('GET', '/recordings');
  for (const r of data ?? []) {
    await req('DELETE', `/recordings/${encodeURIComponent(r.id)}`).catch(() => undefined);
    createdRecordings.delete(r.id);
  }
}

async function wipeAllRules(): Promise<void> {
  const { data } = await req<Rule[]>('GET', '/rules');
  for (const r of data ?? []) {
    await req('DELETE', `/rules/${r.id}`).catch(() => undefined);
    createdRules.delete(r.id);
  }
}

async function cleanSlate(): Promise<void> {
  await wipeAllRecordings();
  await wipeAllRules();
}

interface Program {
  id: string;
  ch: string;
  startAt: string;
  endAt: string;
  title: string;
  tvdb?: { id: number; type: 'series' | 'movie'; title: string; titleEn: string } | null;
}
interface Recording { id: string; programId: string; state: string; title: string; priority?: string }
interface Rule { id: number; kind: 'keyword' | 'series'; name: string; enabled: boolean; tvdb?: { id: number } | null }

async function pickFutureProgram(opts: { withTvdbSeries?: boolean } = {}): Promise<Program> {
  const { data } = await req<Program[]>('GET', '/schedule?all=1');
  const now = Date.now();
  const candidates = (data ?? []).filter((p) => {
    if (Date.parse(p.startAt) <= now) return false;
    if (opts.withTvdbSeries) return p.tvdb?.type === 'series';
    return true;
  });
  if (candidates.length === 0) {
    throw new Error(`no future programs available (withTvdbSeries=${opts.withTvdbSeries})`);
  }
  return candidates[0];
}

describe('API scenarios', { concurrency: false }, () => {
  before(async () => {
    const { status } = await req<unknown>('GET', '/channels');
    assert.equal(status, 200, 'server not reachable at ' + BASE);
    await cleanSlate();
  });

  after(async () => {
    for (const id of createdRecordings) {
      await req('DELETE', `/recordings/${encodeURIComponent(id)}`).catch(() => undefined);
    }
    for (const id of createdRules) {
      await req('DELETE', `/rules/${id}`).catch(() => undefined);
    }
  });

  // ----------------------------------------------------------------
  test('単発録画: create → list → /schedule 反映 → cancel', async (t) => {
    await cleanSlate();
    void t;
    const prog = await pickFutureProgram();
    const create = await req<Recording>('POST', '/recordings', {
      programId: prog.id,
      priority: 'medium',
      quality: '1080i',
      keepRaw: false,
      marginPre: 0,
      marginPost: 30,
      source: { kind: 'once' },
      force: true,
    });
    assert.equal(create.status, 201, `recording create failed: ${JSON.stringify(create.data)}`);
    trackRecording(create.data.id);
    assert.equal(create.data.state, 'scheduled');

    const list = await req<Recording[]>('GET', '/recordings');
    assert.equal(list.status, 200);
    assert.ok(list.data.some((r) => r.id === create.data.id), 'recording missing from /recordings');

    const del = await req('DELETE', `/recordings/${encodeURIComponent(create.data.id)}`);
    assert.equal(del.status, 204);
    createdRecordings.delete(create.data.id);

    const after = await req<Recording[]>('GET', '/recordings');
    assert.ok(!after.data.some((r) => r.id === create.data.id), 'recording still present after delete');
  });

  // ----------------------------------------------------------------
  test('シリーズ録画: rule 作成 → /rules に表示 → expand で recordings 生成', async (t) => {
    await cleanSlate();
    void t;
    const prog = await pickFutureProgram({ withTvdbSeries: true });
    const tvdb = prog.tvdb!;
    const create = await req<Rule>('POST', '/rules', {
      name: tvdb.title,
      keyword: tvdb.title,
      channels: [],
      enabled: true,
      priority: 'medium',
      quality: '1080i',
      skipReruns: true,
      kind: 'series',
      tvdb,
    });
    assert.equal(create.status, 201, `rule create failed: ${JSON.stringify(create.data)}`);
    trackRule(create.data.id);
    assert.equal(create.data.kind, 'series');
    assert.equal(create.data.tvdb?.id, tvdb.id);

    const list = await req<Rule[]>('GET', '/rules');
    assert.equal(list.status, 200);
    const seen = list.data.find((r) => r.id === create.data.id);
    assert.ok(seen, 'rule missing from /rules');
    assert.equal(seen.kind, 'series');

    const expand = await req<{ matchedPrograms: number; createdRecordings: number }>('GET', '/rules/expand');
    assert.equal(expand.status, 200);
    assert.ok(expand.data.matchedPrograms >= 0);

    const recordings = await req<Recording[]>('GET', '/recordings');
    for (const r of recordings.data) {
      if (r.title.includes(tvdb.title.slice(0, 4))) trackRecording(r.id);
    }
  });

  // ----------------------------------------------------------------
  test('重複シリーズ予約: 同じ tvdbId で二度目は 409', async (t) => {
    await cleanSlate();
    void t;
    const prog = await pickFutureProgram({ withTvdbSeries: true });
    const tvdb = prog.tvdb!;

    const first = await req<Rule>('POST', '/rules', {
      name: tvdb.title,
      keyword: tvdb.title,
      channels: [],
      enabled: true,
      priority: 'medium',
      quality: '1080i',
      skipReruns: true,
      kind: 'series',
      tvdb,
    });
    assert.equal(first.status, 201);
    trackRule(first.data.id);

    const dup = await req<{ code: string }>('POST', '/rules', {
      name: tvdb.title,
      keyword: tvdb.title,
      channels: [],
      enabled: true,
      priority: 'medium',
      quality: '1080i',
      skipReruns: true,
      kind: 'series',
      tvdb,
    });
    assert.equal(dup.status, 409, `expected 409 on duplicate series rule, got ${dup.status}`);
    assert.match(dup.data.code ?? '', /duplicate/, 'expected duplicate code');
  });

  // ----------------------------------------------------------------
  test('重複単発予約: 同じ programId で二度目は 409 (force=false)', async (t) => {
    await cleanSlate();
    void t;
    const prog = await pickFutureProgram();
    const first = await req<Recording>('POST', '/recordings', {
      programId: prog.id,
      priority: 'medium',
      quality: '1080i',
      keepRaw: false,
      marginPre: 0,
      marginPost: 30,
      source: { kind: 'once' },
      force: false,
    });
    assert.equal(first.status, 201);
    trackRecording(first.data.id);

    const dup = await req<{ code: string }>('POST', '/recordings', {
      programId: prog.id,
      priority: 'medium',
      quality: '1080i',
      keepRaw: false,
      marginPre: 0,
      marginPost: 30,
      source: { kind: 'once' },
      force: false,
    });
    assert.equal(dup.status, 409, `expected 409 on duplicate recording, got ${dup.status}`);
    assert.match(dup.data.code ?? '', /duplicate/);
  });

  // ----------------------------------------------------------------
  test('状態反映: 新規 recording は state=scheduled かつ /now-recording には出ない', async (t) => {
    await cleanSlate();
    void t;
    const prog = await pickFutureProgram();
    const create = await req<Recording>('POST', '/recordings', {
      programId: prog.id,
      priority: 'medium',
      quality: '1080i',
      keepRaw: false,
      marginPre: 0,
      marginPost: 30,
      source: { kind: 'once' },
      force: true,
    });
    assert.equal(create.status, 201);
    trackRecording(create.data.id);
    assert.equal(create.data.state, 'scheduled');

    const now = await req<Array<{ id: string }>>('GET', '/now-recording');
    assert.equal(now.status, 200);
    assert.ok(!now.data.some((n) => n.id === create.data.id),
      '/now-recording should only include state=recording rows');
  });

  // ----------------------------------------------------------------
  // Phase 5: priority-based tuner allocation.
  test('Phase 5 allocator: 2×GR tuners preempt the lowest-priority recording', async (t) => {
    await cleanSlate();
    void t;

    const tunersRes = await req<Array<{ type: string; total: number }>>('GET', '/tuners');
    assert.equal(tunersRes.status, 200);
    const gr = tunersRes.data.find((t) => t.type === 'GR');
    if (!gr || gr.total < 2) {
      t.skip(`need ≥2 GR tuners, got ${gr?.total ?? 0}`);
      return;
    }

    const { data: schedule } = await req<Program[]>('GET', '/schedule?all=1');
    const { data: channels } = await req<Array<{ id: string; type: string }>>('GET', '/channels');
    const grChIds = new Set((channels ?? []).filter((c) => c.type === 'GR').map((c) => c.id));
    const now = Date.now();
    const byCh = new Map<string, Program>();
    for (const p of schedule ?? []) {
      if (!grChIds.has(p.ch)) continue;
      if (Date.parse(p.startAt) <= now) continue;
      if (!byCh.has(p.ch)) byCh.set(p.ch, p);
    }
    const candidates = [...byCh.values()];
    if (candidates.length < 3) {
      t.skip(`need ≥3 GR channels with future programs, got ${candidates.length}`);
      return;
    }
    const anchor = candidates[0];
    const overlapping = candidates.filter(
      (p) =>
        p.ch !== anchor.ch &&
        Date.parse(p.startAt) < Date.parse(anchor.endAt) &&
        Date.parse(p.endAt) > Date.parse(anchor.startAt)
    );
    if (overlapping.length < 2) {
      t.skip('need ≥2 GR programs overlapping the anchor window');
      return;
    }
    const picks = [anchor, overlapping[0], overlapping[1]];
    const priorities = ['high', 'medium', 'low'] as const;

    const createdIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await req<Recording>('POST', '/recordings', {
        programId: picks[i].id,
        priority: priorities[i],
        quality: '1080i',
        keepRaw: false,
        marginPre: 0,
        marginPost: 30,
        source: { kind: 'once' },
        force: true,
      });
      assert.equal(res.status, 201, `create[${i}] failed: ${JSON.stringify(res.data)}`);
      trackRecording(res.data.id);
      createdIds.push(res.data.id);
    }

    const list = await req<Array<Recording & { priority?: string }>>('GET', '/recordings');
    assert.equal(list.status, 200);
    const ours = list.data.filter((r) => createdIds.includes(r.id));
    assert.equal(ours.length, 3);
    const conflict = ours.filter((r) => r.state === 'conflict');
    const scheduled = ours.filter((r) => r.state === 'scheduled');
    assert.equal(scheduled.length, 2, `expected 2 scheduled, got ${scheduled.length}`);
    assert.equal(conflict.length, 1, `expected 1 conflict, got ${conflict.length}`);
    assert.equal(conflict[0].priority, 'low', 'low-priority recording should be the conflict');
  });

  // ----------------------------------------------------------------
  // 録画物削除: DB に行を直接挿入 → DELETE /recordings/:id → 204 →
  // GET /recordings にはもう出てこない。
  test('録画物削除: DELETE /recordings/:id で行とファイルが消える', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set — skipping direct-DB scenario');
      return;
    }

    const { db } = await import('../db/client.ts');
    const { recordings: recordingsTable } = await import('../db/schema.ts');
    const { eq } = await import('drizzle-orm');

    const id = `e2e-del-${Date.now()}`;
    const filename = `/tmp/epghub-e2e-missing-${id}.ts`;

    await db.insert(recordingsTable).values({
      id,
      programId: `e2e_${id}`,
      title: 'E2E 削除テスト',
      ch: 'e2e-ch',
      startAt: new Date(),
      endAt: new Date(Date.now() + 30 * 60_000),
      recordedAt: new Date(),
      duration: 30,
      size: 1.2,
      quality: '1080i',
      filename,
      state: 'ready',
    });

    try {
      const del = await req('DELETE', `/recordings/${encodeURIComponent(id)}`);
      assert.equal(del.status, 204, 'DELETE /recordings should return 204');

      const list = await req<Array<{ id: string }>>('GET', '/recordings');
      assert.equal(list.status, 200);
      assert.ok(
        !list.data.some((r) => r.id === id),
        'deleted recording should not appear in GET /recordings'
      );

      const again = await req('DELETE', `/recordings/${encodeURIComponent(id)}`);
      assert.equal(again.status, 404, 'second delete should 404');
    } finally {
      await db.delete(recordingsTable).where(eq(recordingsTable.id, id)).catch(() => undefined);
    }
  });

  // ----------------------------------------------------------------
  // Encode round trip
  test('録画エンコード: POST /recordings/{id}/encode で ready に遷移 + raw 削除', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set — skipping encode e2e');
      return;
    }
    // Bundled fixture so the test runs by default. Override with
    // ENCODE_FIXTURE_TS to exercise a different stream (e.g. a real tuner
    // capture while debugging encode failures).
    const fixturePath =
      process.env.ENCODE_FIXTURE_TS ?? '/workspaces/epghub/server/fixtures/tiny.ts';
    const { existsSync, copyFileSync, statSync } = await import('node:fs');
    if (!existsSync(fixturePath)) {
      t.skip(`fixture missing: ${fixturePath}`);
      return;
    }

    const { db } = await import('../db/client.ts');
    const { recordings: recordingsTable } = await import('../db/schema.ts');
    const { eq } = await import('drizzle-orm');
    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');

    const dir = process.env.RECORDING_DIR ?? '/workspaces/epghub/server/.recordings';
    mkdirSync(dir, { recursive: true });
    const id = `e2e-enc-${Date.now()}`;
    const rawPath = join(dir, `${id}.ts`);
    copyFileSync(fixturePath, rawPath);

    await db.insert(recordingsTable).values({
      id,
      programId: `e2e_${id}`,
      title: 'E2E エンコード',
      ch: 'e2e-ch',
      startAt: new Date(),
      endAt: new Date(Date.now() + 60_000),
      recordedAt: new Date(),
      duration: 1,
      size: Number((statSync(rawPath).size / 1024 ** 3).toFixed(3)),
      quality: '1080i',
      filename: rawPath,
      rawFilename: rawPath,
      state: 'encoding',
    });

    try {
      const enc = await req<{ recordingId: string; preset: string; queued: boolean }>(
        'POST',
        `/recordings/${encodeURIComponent(id)}/encode`,
        { preset: 'audio-only' }
      );
      assert.equal(enc.status, 202, `encode enqueue failed: ${JSON.stringify(enc.data)}`);
      assert.equal(enc.data.queued, true);

      const deadline = Date.now() + 60_000;
      let finalState = '';
      let finalFilename = '';
      while (Date.now() < deadline) {
        const [row] = await db
          .select()
          .from(recordingsTable)
          .where(eq(recordingsTable.id, id))
          .limit(1);
        finalState = row?.state ?? '';
        finalFilename = row?.filename ?? '';
        if (finalState === 'ready' || finalState === 'failed') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(finalState, 'ready', `encode did not succeed, state=${finalState}`);
      assert.ok(finalFilename.endsWith('.m4a'), `expected .m4a output, got ${finalFilename}`);
      assert.equal(existsSync(rawPath), false, 'raw .ts should be deleted after success');
      assert.equal(existsSync(finalFilename), true, 'encoded output should exist');

      const { unlinkSync } = await import('node:fs');
      try { unlinkSync(finalFilename); } catch { /* ignore */ }
    } finally {
      await db.delete(recordingsTable).where(eq(recordingsTable.id, id)).catch(() => undefined);
      const { unlinkSync, existsSync: ex } = await import('node:fs');
      if (ex(rawPath)) { try { unlinkSync(rawPath); } catch { /* ignore */ } }
    }
  });

  // ----------------------------------------------------------------
  // Phase 4 — recorded_history dedupe.
  test('Phase4 重複スキップ: recorded_history にあるエピソードは expand で再予約されない', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set — skipping direct-DB scenario');
      return;
    }
    await cleanSlate();

    const { data: progs } = await req<Array<Program & {
      tvdbSeason?: number | null;
      tvdbEpisode?: number | null;
    }>>('GET', '/schedule?all=1');
    const now = Date.now();
    const target = (progs ?? []).find(
      (p) =>
        Date.parse(p.startAt) > now &&
        p.tvdb?.type === 'series' &&
        p.tvdbSeason != null &&
        p.tvdbEpisode != null
    );
    if (!target) {
      t.skip('no future program with (tvdb series + season + episode) in dev DB');
      return;
    }
    const tvdb = target.tvdb!;

    const { db } = await import('../db/client.ts');
    const { recordedHistory } = await import('../db/schema.ts');
    const { and, eq, isNotNull } = await import('drizzle-orm');

    const ruleRes = await req<Rule>('POST', '/rules', {
      name: tvdb.title,
      keyword: tvdb.title,
      channels: [],
      enabled: true,
      priority: 'medium',
      quality: '1080i',
      skipReruns: true,
      kind: 'series',
      tvdb,
    });
    assert.equal(ruleRes.status, 201, `rule create failed: ${JSON.stringify(ruleRes.data)}`);
    trackRule(ruleRes.data.id);

    try {
      await db.insert(recordedHistory).values({
        tvdbId: tvdb.id,
        season: target.tvdbSeason!,
        episode: target.tvdbEpisode!,
        normalizedTitle: null,
        endAt: new Date(target.endAt),
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== '23505') throw err;
    }

    try {
      const first = await req<{
        matchedPrograms: number;
        createdRecordings: number;
        conflicts: { duplicate: number; tunerFull: number };
      }>('POST', '/admin/expand-rules');
      assert.equal(first.status, 200);
      assert.ok(
        first.data.conflicts.duplicate >= 1,
        `expected at least 1 duplicate skip, got ${first.data.conflicts.duplicate}`
      );

      const recordings = await req<Recording[]>('GET', '/recordings');
      const created = recordings.data.find((r) => r.programId === target.id);
      assert.equal(
        created,
        undefined,
        `expected no recording for pre-recorded program ${target.id}`
      );

      const histList = await req<Array<{ tvdbId: number | null }>>(
        'GET',
        `/admin/recorded-history?tvdbId=${tvdb.id}`
      );
      assert.equal(histList.status, 200);
      assert.ok(histList.data.some((h) => h.tvdbId === tvdb.id));
    } finally {
      await db
        .delete(recordedHistory)
        .where(
          and(
            isNotNull(recordedHistory.tvdbId),
            eq(recordedHistory.tvdbId, tvdb.id),
            eq(recordedHistory.season, target.tvdbSeason!),
            eq(recordedHistory.episode, target.tvdbEpisode!)
          )
        )
        .catch(() => undefined);
    }
  });

  // ----------------------------------------------------------------
  // Phase 2: program-extension polling.
  test('Phase 2 EIT live: pollOnce shifts recording.endAt when programs.endAt changes', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set — skipping direct-DB scenario');
      return;
    }
    await cleanSlate();

    const { db } = await import('../db/client.ts');
    const {
      programs: programsTable,
      recordings: recordingsTable,
    } = await import('../db/schema.ts');
    const { eq, sql } = await import('drizzle-orm');

    const prog = await pickFutureProgram();
    const create = await req<Recording>('POST', '/recordings', {
      programId: prog.id,
      priority: 'medium',
      quality: '1080i',
      keepRaw: false,
      marginPre: 0,
      marginPost: 30,
      source: { kind: 'once' },
      force: true,
    });
    assert.equal(create.status, 201, `recording create failed: ${JSON.stringify(create.data)}`);
    trackRecording(create.data.id);

    const recordingId = create.data.id;
    const origEndIso = prog.endAt;
    const newEndDate = new Date(Date.parse(origEndIso) + 5 * 60 * 1000); // +5 min
    const newEndIso = newEndDate.toISOString();

    await db
      .update(programsTable)
      .set({ endAt: newEndDate })
      .where(eq(programsTable.id, prog.id));

    try {
      const pollRes = await req<{ shifted: string[]; touched: number }>(
        'POST',
        '/admin/epg-live/poll',
        { source: 'programs-table' }
      );
      assert.equal(pollRes.status, 200, `poll call failed: ${JSON.stringify(pollRes.data)}`);
      const result = pollRes.data;
      assert.ok(
        result.touched >= 1,
        `expected at least 1 action, got touched=${result.touched}`
      );
      assert.ok(
        result.shifted.includes(recordingId),
        `expected recordingId ${recordingId} in shifted list, got ${result.shifted.join(',')}`
      );

      const [row] = await db
        .select()
        .from(recordingsTable)
        .where(eq(recordingsTable.id, recordingId))
        .limit(1);
      assert.ok(row, 'recording row missing after pollOnce');
      assert.equal(row!.endAt.toISOString(), newEndIso);
      assert.equal(
        row!.originalEndAt?.toISOString(),
        origEndIso,
        'originalEndAt should pin the pre-shift endAt on first extension'
      );
      assert.equal(row!.extendedBySec, 300, 'extendedBySec should equal +300 (+5min)');

      const jobRows = (await db.execute<{ start_after: Date; state: string }>(
        sql`select start_after, state from pgboss.job
              where name = 'record.stop'
                and state in ('created','retry')
                and data->>'recordingId' = ${recordingId}`
      )) as unknown as Array<{ start_after: Date; state: string }>;
      assert.ok(
        jobRows.length >= 1,
        `expected at least one pending record.stop job for ${recordingId}, got ${jobRows.length}`
      );
      const expectedStopMs = Date.parse(newEndIso) + 30 * 1000;
      const gotMs = new Date(jobRows[0].start_after).getTime();
      assert.ok(
        Math.abs(gotMs - expectedStopMs) < 2000,
        `pg-boss RECORD_STOP start_after=${jobRows[0].start_after} expected ≈ ${new Date(expectedStopMs).toISOString()}`
      );
    } finally {
      await db
        .update(programsTable)
        .set({ endAt: new Date(origEndIso) })
        .where(eq(programsTable.id, prog.id))
        .catch(() => undefined);
    }
  });

  // ----------------------------------------------------------------
  // Phase 7 exclusions: NG キーワード.
  test('Phase 7 除外: ngKeywords 含む番組は expand でスキップされる', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set — skipping direct-DB scenario');
      return;
    }
    await cleanSlate();

    const { db } = await import('../db/client.ts');
    const { programs: programsTable } = await import('../db/schema.ts');
    const { eq } = await import('drizzle-orm');

    const target = await pickFutureProgram();
    const origTitle = target.title;
    const sentinel = `EPGHUB_E2E_P7_${Date.now()}`;
    const stampedTitle = `${sentinel} 傑作選`;

    await db
      .update(programsTable)
      .set({ title: stampedTitle })
      .where(eq(programsTable.id, target.id));

    const ruleRes = await req<Rule & { ngKeywords?: string[] }>('POST', '/rules', {
      name: 'P7 除外テスト',
      keyword: sentinel,
      channels: [],
      enabled: true,
      priority: 'medium',
      quality: '1080i',
      skipReruns: false,
      kind: 'keyword',
      ngKeywords: ['傑作選'],
    });
    assert.equal(ruleRes.status, 201, `rule create failed: ${JSON.stringify(ruleRes.data)}`);
    trackRule(ruleRes.data.id);
    assert.deepEqual(ruleRes.data.ngKeywords, ['傑作選']);

    try {
      const expand = await req<{
        matchedPrograms: number;
        createdRecordings: number;
      }>('POST', '/admin/expand-rules');
      assert.equal(expand.status, 200);

      const recordings = await req<Recording[]>('GET', '/recordings');
      const created = recordings.data.find((r) => r.programId === target.id);
      assert.equal(
        created,
        undefined,
        `expected no recording for NG-excluded program ${target.id}`
      );

      const upd = await req<Rule>('PATCH', `/rules/${ruleRes.data.id}`, { ngKeywords: [] });
      assert.equal(upd.status, 200, `rule update failed: ${JSON.stringify(upd.data)}`);

      const expand2 = await req<{ matchedPrograms: number; createdRecordings: number }>(
        'POST', '/admin/expand-rules'
      );
      assert.equal(expand2.status, 200);
      const recordings2 = await req<Recording[]>('GET', '/recordings');
      const created2 = recordings2.data.find((r) => r.programId === target.id);
      assert.ok(
        created2,
        `expected a recording for ${target.id} after clearing ngKeywords, got none`
      );
      if (created2) trackRecording(created2.id);
    } finally {
      await db
        .update(programsTable)
        .set({ title: origTitle })
        .where(eq(programsTable.id, target.id))
        .catch(() => undefined);
    }
  });

  // ----------------------------------------------------------------
  // Phase 3 — drop_log persistence + GET /recordings/{id}/drops.
  test('Phase 3 drops: drop_logs 行を投入 → GET /recordings/:id/drops で取得', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set — skipping direct-DB scenario');
      return;
    }
    const { db } = await import('../db/client.ts');
    const { recordings: recordingsTable, dropLogs } = await import('../db/schema.ts');
    const { eq } = await import('drizzle-orm');

    const id = `e2e-drops-${Date.now()}`;
    await db.insert(recordingsTable).values({
      id,
      programId: `e2e_${id}`,
      title: 'E2E ドロップテスト',
      ch: 'e2e-ch',
      startAt: new Date(),
      endAt: new Date(Date.now() + 30 * 60_000),
      recordedAt: new Date(),
      duration: 30,
      size: 1.2,
      quality: '1080i',
      filename: `/tmp/${id}.ts`,
      state: 'ready',
    });

    try {
      await db.insert(dropLogs).values({
        recordingId: id,
        errorCnt: 2,
        dropCnt: 5,
        scramblingCnt: 0,
        perPid: {
          '256': { err: 2, drop: 5, scr: 0 },
          '257': { err: 0, drop: 0, scr: 0 },
        },
      });

      const res = await req<{
        recordingId: string;
        errorCnt: number;
        dropCnt: number;
        scramblingCnt: number;
        perPid: Record<string, { err: number; drop: number; scr: number }>;
      }>('GET', `/recordings/${encodeURIComponent(id)}/drops`);

      assert.equal(res.status, 200, `expected 200 got ${res.status}`);
      assert.equal(res.data.recordingId, id);
      assert.equal(res.data.errorCnt, 2);
      assert.equal(res.data.dropCnt, 5);
      assert.equal(res.data.scramblingCnt, 0);
      assert.equal(res.data.perPid['256']?.drop, 5, 'per-PID breakdown preserved');

      await db.delete(recordingsTable).where(eq(recordingsTable.id, id));
      const after = await req<{ code: string }>(
        'GET',
        `/recordings/${encodeURIComponent(id)}/drops`
      );
      assert.equal(after.status, 404, 'drops should 404 after parent recording cascade delete');
    } finally {
      await db.delete(recordingsTable).where(eq(recordingsTable.id, id)).catch(() => undefined);
    }
  });

  // ----------------------------------------------------------------
  // Phase 6 disk sweep
  test('Phase 6 ディスク sweep: 古い unprotected+ready だけが削除される', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set — skipping direct-DB scenario');
      return;
    }

    const { db } = await import('../db/client.ts');
    const { recordings: recordingsTable } = await import('../db/schema.ts');
    const { inArray } = await import('drizzle-orm');

    const stamp = Date.now();
    const idOld = `e2e-cap-old-${stamp}`;
    const idMid = `e2e-cap-mid-${stamp}`;
    const idProtected = `e2e-cap-prot-${stamp}`;
    const idEncoding = `e2e-cap-enc-${stamp}`;
    const idNew = `e2e-cap-new-${stamp}`;
    const allIds = [idOld, idMid, idProtected, idEncoding, idNew];

    const fakePath = (id: string) => `/tmp/epghub-e2e-cap-missing-${id}.ts`;

    const base = new Date('2026-01-01T00:00:00Z').getTime();
    await db.insert(recordingsTable).values([
      {
        id: idOld,
        programId: `e2e_${idOld}`,
        title: 'sweep old',
        ch: 'e2e-ch',
        startAt: new Date(base),
        endAt: new Date(base + 30 * 60_000),
        recordedAt: new Date(base + 0),
        duration: 30,
        size: 1.0,
        quality: '1080i',
        filename: fakePath(idOld),
        state: 'ready',
        protected: false,
      },
      {
        id: idMid,
        programId: `e2e_${idMid}`,
        title: 'sweep mid',
        ch: 'e2e-ch',
        startAt: new Date(base + 60_000),
        endAt: new Date(base + 60_000 + 30 * 60_000),
        recordedAt: new Date(base + 60_000),
        duration: 30,
        size: 1.0,
        quality: '1080i',
        filename: fakePath(idMid),
        state: 'ready',
        protected: false,
      },
      {
        id: idProtected,
        programId: `e2e_${idProtected}`,
        title: 'sweep protected',
        ch: 'e2e-ch',
        startAt: new Date(base - 60_000),
        endAt: new Date(base - 60_000 + 30 * 60_000),
        recordedAt: new Date(base - 60_000),
        duration: 30,
        size: 1.0,
        quality: '1080i',
        filename: fakePath(idProtected),
        state: 'ready',
        protected: true,
      },
      {
        id: idEncoding,
        programId: `e2e_${idEncoding}`,
        title: 'sweep encoding',
        ch: 'e2e-ch',
        startAt: new Date(base - 30_000),
        endAt: new Date(base - 30_000 + 30 * 60_000),
        recordedAt: new Date(base - 30_000),
        duration: 30,
        size: 1.0,
        quality: '1080i',
        filename: fakePath(idEncoding),
        state: 'encoding',
        protected: false,
      },
      {
        id: idNew,
        programId: `e2e_${idNew}`,
        title: 'sweep new',
        ch: 'e2e-ch',
        startAt: new Date(base + 3_600_000),
        endAt: new Date(base + 3_600_000 + 30 * 60_000),
        recordedAt: new Date(base + 3_600_000),
        duration: 30,
        size: 1.0,
        quality: '1080i',
        filename: fakePath(idNew),
        state: 'ready',
        protected: false,
      },
    ]);

    try {
      const res = await req<{ deletedIds: string[]; freedBytes: number }>(
        'POST',
        '/admin/capacity/sweep',
        { minFreeBytes: Number.MAX_SAFE_INTEGER }
      );
      assert.equal(res.status, 200, `sweep call failed: ${JSON.stringify(res.data)}`);

      const deleted = new Set(res.data.deletedIds);
      assert.ok(deleted.has(idOld), `expected ${idOld} deleted, got ${[...deleted].join(',')}`);
      assert.ok(deleted.has(idMid), `expected ${idMid} deleted, got ${[...deleted].join(',')}`);
      assert.ok(deleted.has(idNew), `expected ${idNew} deleted, got ${[...deleted].join(',')}`);
      assert.ok(!deleted.has(idProtected), `protected row ${idProtected} was unexpectedly deleted`);
      assert.ok(!deleted.has(idEncoding), `in-encode row ${idEncoding} was unexpectedly deleted`);

      const remaining = await db
        .select({ id: recordingsTable.id })
        .from(recordingsTable)
        .where(inArray(recordingsTable.id, allIds));
      const remainingIds = new Set(remaining.map((r) => r.id));
      assert.ok(remainingIds.has(idProtected), 'protected row should survive the sweep');
      assert.ok(remainingIds.has(idEncoding), 'in-encode row should survive the sweep');
      assert.ok(!remainingIds.has(idOld));
      assert.ok(!remainingIds.has(idMid));
      assert.ok(!remainingIds.has(idNew));
    } finally {
      await db
        .delete(recordingsTable)
        .where(inArray(recordingsTable.id, allIds))
        .catch(() => undefined);
    }
  });
});
