---
name: fix-episode-match
description: Use when the user reports a wrong S/E mapping for a specific `programs.id` and tells you what the expected season/episode is — typical phrasings are "programs.id = ... これがなぜ s1e2?", "正しいのは○話", "○○なのでマッチしないのが期待値", "このパターン直して/追加して". Diagnoses the wrong mapping in `findEpisodeForProgram`, fixes the matching logic in `server/src/services/matchService.ts`, adds a regression test in `findEpisodeForProgram.test.ts`, and runs the test+typecheck+golden suite to confirm no regression.
---

# Episode-match diagnosis & fix workflow

Whenever the user gives you a `programs.id` plus the expected matching
outcome (a specific S/E, or "should not match anything"), follow this
workflow. The deliverable is always: **code fix + regression test +
green test suite.**

## Files that matter

- **`server/src/services/matchService.ts`** — `findEpisodeForProgram` (signal cascade) and the rerun-pattern fallback inside `applyTvdbToPrograms`. Almost every fix lands here.
- **`server/src/services/findEpisodeForProgram.test.ts`** — pure-logic regression tests. Add one `test(...)` per case and group related cases under a `describe('— <show> regression case')`.
- **DB tables** — read-only here. `programs` row (title, ep, series, tvdb_id, tvdb_season/episode, start_at) and `tvdb_entries.episodes` (cached `[{s,e,name,aired}]` array).

Do not touch DB data — the user's standing rule is "再マッチは不要"
(skill is code-only, no UPDATE statements).

## Step 1: pull both sides of the mismatch

Run these via Bash. Use the standard `DATABASE_URL` default if `$DATABASE_URL` is unset.

```sh
psql "${DATABASE_URL:-postgresql://epghub:epghub@localhost:5432/epghub}" -c \
  "SELECT id, title, ep, series, tvdb_id, tvdb_season, tvdb_episode, tvdb_episode_name, start_at FROM programs WHERE id = '<PROGRAM_ID>';"
```

Then dump the cached TVDB episode list for the linked `tvdb_id`:

```sh
psql "${DATABASE_URL:-postgresql://epghub:epghub@localhost:5432/epghub}" -c \
  "SELECT (e->>'s')::int AS s, (e->>'e')::int AS e, e->>'name' AS name, e->>'aired' AS aired FROM tvdb_entries, jsonb_array_elements(episodes) e WHERE tvdb_id = <TVDB_ID> ORDER BY (e->>'s')::int, (e->>'e')::int;"
```

If it would help to see how a whole show's programs were assigned (e.g.
to confirm the rerun-pattern fallback misfired across a slate), also run:

```sh
psql "${DATABASE_URL:-postgresql://epghub:epghub@localhost:5432/epghub}" -c \
  "SELECT tvdb_season, tvdb_episode, count(*) AS n, min(start_at), max(start_at) FROM programs WHERE tvdb_id = <TVDB_ID> GROUP BY tvdb_season, tvdb_episode ORDER BY tvdb_season NULLS LAST, tvdb_episode NULLS LAST;"
```

## Step 2: trace the signal cascade

`findEpisodeForProgram` (matchService.ts) runs four steps in order. Walk
through them mentally for the EPG title against the cached episode list:

1. **Quoted subtitle** — every `「…」`/`『…』` segment in the title is normalised (`normalizeEpisodeName`: zenkaku→hankaku digits/letters, lowercase, strip whitespace) and looked up against every `name` in the cached episode list. First hit wins; specials (s=0) are deprioritised. Series-unique → pins the season directly.
2. **Episode number from title** (`parseTitleEpisodeNumber`) — checks, in order: `#N`/`＃N`, `第N話/回/夜/局` (digits), `第N話/回/夜/局` (kanji digits), `ep N`, `（NN）` (zenkaku parens — NHK 連続テレビ小説 daily-ep). Hankaku `(N)` is intentionally NOT parsed (year tags / runtime). On hit, filter `episodes.e === N` and pick the highest season.
3. **Cumulative-N fallback** — only when step 2's number doesn't directly hit any episode. Walks seasons s≥1 ascending, accumulating `maxE`; once N lands inside the running total, that season's relative episode is the match. Handles broadcasters that number across seasons (ダンダダン #18 = S1.12 + S2.6 → S2E6).
4. **Aired-day fallback** — JST broadcast-day (program.start_at - 5h, then YYYY-MM-DD) compared to `aired`. Useful when the title carries no number/subtitle.

In `applyTvdbToPrograms` there's also a **rerun-pattern fallback** that
mass-assigns unresolved programs of one tvdb_id to S1E1, S1E2, …
chronologically. It only fires when (a) the cache's latest aired date
is more than 60 days before the earliest unresolved program (i.e. a
stale rerun) AND (b) no unresolved program carries an episode marker.
A program ending up at a sequential `S1E<small>` despite a marker in
its title almost always means this fallback misfired in older code.

Pick the lowest-numbered step that *should* have produced the expected
answer but didn't. That gap is your fix.

## Step 3: fix the root cause (no hardcoding)

The user's strict rule: **never embed show-specific special cases**.
Generalise to a structural property of EPG broadcaster metadata.

Examples of acceptable generalisations:
- New regex pattern in `parseTitleEpisodeNumber` for a broadcaster-wide
  numbering convention (zenkaku parens for NHK 朝ドラ daily ep, `第N夜`
  for late-night dramas, etc.).
- New normalisation rule in `normalizeEpisodeName` for a punctuation
  class that consistently differs between EPG and TVDB.
- Tighter precondition on the rerun-pattern fallback when a class of
  programs (markered titles, recently-aired cache) shouldn't trigger it.

Examples that get rejected:
- `if (title.includes('風、薫る'))` or any other show-name guard.
- A "tiebreaker" branch that only fires for one specific collision.
- Hardcoded TVDB IDs in matchService.

If you're not sure whether the fix is general enough, sanity-check by
asking: "would this same change help any other show that follows the
same broadcaster convention?" If no, it's special-casing.

## Step 4: add a regression test

Always add a `test(...)` to `findEpisodeForProgram.test.ts` that uses
the **exact program title and start time from the DB** (so the test is
self-documenting — anyone reading it can see which real-world EPG
artefact it locks down). Group multiple cases for the same show under
one `describe('findEpisodeForProgram — <show> regression case')`.

Test data convention:
- Build the `episodes` array from the actual TVDB cache dump (Step 1's
  second query). Trim irrelevant episodes only when they'd make the
  test unreadable.
- Use the program's real `start_at` (UTC ISO) as `programStartIso`.
- Use the program's real `title` as `programTitle`.
- Comment the test with the source `programs.id` so future readers can
  re-run Step 1 to refresh context.

`findEpisodeForProgram` returns `{ s, e, name? } | null`. It does NOT
include `aired` — assertions that include it will fail.

When the expected outcome is "no match", assert `assert.equal(hit, null)`.

## Step 5: run the suite

From `server/`:

```sh
node --import tsx --test src/services/findEpisodeForProgram.test.ts
npm run typecheck
npm run test:golden
```

All three must be green before you report done. If any unrelated test
fails, investigate — your normalisation/regex change may have broken a
neighbouring case.

## Step 5.5: end-to-end verification against the live DB row

Synthetic tests can pass while the real program still resolves wrong
because the test fixture differs subtly from the actual TVDB cache or
EPG title (zenkaku/hankaku, hidden control chars, missing show titles
etc). Always run the verification script to close that loop:

```sh
node --import tsx scripts/verify-match.ts '<PROGRAM_ID>'
```

The script (`server/scripts/verify-match.ts`) loads the program row,
the linked `tvdb_entries` row (title + titleEn + episodes), and calls
`findEpisodeForProgram(episodes, startAt, title, showTitles)` exactly
like `applyTvdbToPrograms` would in production. It prints the raw
result so you can compare against the user's expected S/E.

Two outcomes are normal:
- **Result matches expected** — done. The fix is correct end-to-end.
- **Result is null but program already has S/E** — that's the cached
  match from a previous run. Don't update the DB; just confirm the
  current S/E is also correct (the user may have seen a stale UI
  cache, or the cache has since been refreshed by the periodic worker).

If `findEpisodeForProgram` still returns wrong / null for the actual
program row, the synthetic test must be wrong — adjust the fixture or
fix logic, then re-verify. Don't ship until script output agrees with
the test assertion.

Do **not** UPDATE the program row directly to fix the live state — the
user's standing rule is "再マッチは不要" / "DB 触らない". The next
periodic enrichment will pick up the new code.

## Step 6: report back

Tell the user:
1. **What the diagnosis was** (which step failed, why).
2. **What you changed** (one-liner per file).
3. **Test count delta** (e.g. "+3 tests, all 27 pass").

Keep it under ~6 lines unless asked. Do **not** run `git commit` —
the user has a standing rule against auto-commit.

## Things to avoid

- DB writes (no UPDATE/INSERT). Code-only change.
- Adding show-specific regexes / tvdbId guards / show-name string checks.
- Touching `app/src/api/epghub.gen.ts` or `server/openapi.yaml` (unrelated).
- Running `npm test` or `npm run test:e2e` (slow, DB-dependent — the
  three commands in Step 5 are sufficient for this skill).
- Committing changes.
