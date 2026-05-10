---
name: fix-episode-match
description: Use when the user reports a wrong S/E mapping for a specific `programs.id` and tells you what the expected season/episode is — typical phrasings are "programs.id = ... これがなぜ s1e2?", "正しいのは○話", "○○なのでマッチしないのが期待値", "このパターン直して/追加して". Diagnoses the wrong mapping in `findEpisodeForProgram`, fixes the matching logic in `server/src/services/matchService.ts`, adds a regression test in `findEpisodeForProgram.test.ts`, and runs the test+typecheck+golden suite to confirm no regression.
---

# Episode-match diagnosis & fix workflow

Given a `programs.id` and the expected outcome (a specific S/E, or "no
match"), deliver: **code fix + regression test + green test suite**.

## Files that matter

- **`server/src/services/matchService.ts`** — `findEpisodeForProgram`
  (signal cascade) + the rerun-pattern fallback in `applyTvdbToPrograms`.
- **`server/src/services/findEpisodeForProgram.test.ts`** — pure-logic
  regression tests. Group cases per show under one `describe`.
- **DB tables** — read-only here. `programs`, `tvdb_entries.episodes`.

Standing rule: **no DB writes.** Skill is code-only ("再マッチは不要").

## Step 1: pull both sides of the mismatch

```sh
psql "${DATABASE_URL:-postgresql://epghub:epghub@localhost:5432/epghub}" -c \
  "SELECT id, title, ep, series, tvdb_id, tvdb_season, tvdb_episode, tvdb_episode_name, start_at FROM programs WHERE id = '<PROGRAM_ID>';"

psql "${DATABASE_URL:-postgresql://epghub:epghub@localhost:5432/epghub}" -c \
  "SELECT (e->>'s')::int AS s, (e->>'e')::int AS e, e->>'name' AS name, e->>'aired' AS aired FROM tvdb_entries, jsonb_array_elements(episodes) e WHERE tvdb_id = <TVDB_ID> ORDER BY (e->>'s')::int, (e->>'e')::int;"
```

To confirm a fallback misfired across a slate, also dump the per-show
S/E distribution:

```sh
psql "${DATABASE_URL:-postgresql://epghub:epghub@localhost:5432/epghub}" -c \
  "SELECT tvdb_season, tvdb_episode, count(*) FROM programs WHERE tvdb_id = <TVDB_ID> GROUP BY tvdb_season, tvdb_episode ORDER BY tvdb_season NULLS LAST, tvdb_episode NULLS LAST;"
```

## Step 2: trace the signal cascade

`findEpisodeForProgram` runs four steps in order:

1. **Quoted subtitle** — every `「…」`/`『…』` segment is normalised
   (zenkaku→hankaku, lowercase, strip whitespace) and looked up against
   `episodes[].name`. First hit wins; specials (s=0) deprioritised.
2. **Episode number from title** (`parseTitleEpisodeNumber`) — checks,
   in order: `#N`/`＃N`, `第N話/回/夜/局/輪/席/食目` (digits + kanji),
   `ep N`, `（NN）` zenkaku parens (NHK 朝ドラ daily-ep), bare `N話/回`.
   Hankaku `(N)` is intentionally NOT parsed (year tags / runtime). On
   hit: filter `episodes.e === N`, pick the highest season.
3. **Cumulative-N fallback** — only when step 2 doesn't directly hit.
   Walks seasons s≥1 ascending, accumulating `maxE`; once N lands
   inside the running total, that season's relative episode is the
   match (ダンダダン #18 = S1.12 + S2.6 → S2E6).
4. **Aired-day fallback** — JST broadcast-day (start_at − 5h, then
   YYYY-MM-DD) compared to `aired`.

`applyTvdbToPrograms` also has a **rerun-pattern fallback** that
mass-assigns S1E1, S1E2, … chronologically when (a) cache's latest
aired date is >60 days before the earliest unresolved program AND
(b) no unresolved program carries an episode marker. A program at a
sequential `S1E<small>` despite a marker in its title usually means
this fallback misfired in older code.

Pick the lowest-numbered step that *should* have produced the expected
answer but didn't — that gap is your fix.

## Step 3: fix the root cause (no hardcoding)

Strict rule: **never embed show-specific special cases.** Generalise to
a structural property of EPG broadcaster metadata.

✅ Acceptable: a regex in `parseTitleEpisodeNumber` for a broadcaster-
wide numbering convention; a normalisation rule in `normalizeEpisodeName`
for a punctuation class that consistently differs between EPG and TVDB;
a tighter precondition on the rerun-pattern fallback.

❌ Rejected: `if title.includes('風、薫る')`; a tiebreaker that fires
only on one collision; hardcoded TVDB IDs.

Sanity check: "would this same change help any other show that follows
the same broadcaster convention?" If no, it's special-casing.

### Don't pick — enumerate (with API-load awareness)

When the input is ambiguous, don't commit to one interpretation. The
matcher already has scoring (`scoreOf`) and a four-step cascade — feed
them, don't pre-empt them. **But fan-out has a cost** — every extra
search-level candidate is one rate-limited TVDB call.

You're in the wrong shape when:
- Adding the Nth literal to a list (`日5`, then `土6`, then `月8` …) —
  list grows without bound.
- Confident the answer is "the part before / inside / after X" but all
  three are plausible. Generate all three.
- The fix needs a show-specific literal guard (`if title.includes(…)`,
  hardcoded TVDB id).

Where to fix, in order of preference:

| Layer | Mechanism | API cost |
|---|---|---|
| Normaliser strip | `TRAILING_KANA_DIGIT_RE` / `TRAILING_KANA_ROMAN_RE` siblings | 0 |
| Normaliser whitelist | `BLOCK_PREFIXES` general regex | 0 |
| Cascade extension | new step or candidate in `findEpisodeForProgram` | 0 |
| Search-level fan-out | `searchKeyCandidates` relaxation | +1 search per candidate |

**Look for a `TRAILING_*_RE` sibling BEFORE reaching for search-level
fan-out.** If the case is "broadcaster appends a sequel/season marker
to a Japanese show name and TVDB carries the no-marker canonical form",
a sibling regex on the same shape is the right move.

### Calibrating a trailing-marker regex

Existing siblings: `TRAILING_KANA_DIGIT_RE` (1 hankaku digit at end-of-
string after kana/kanji) and `TRAILING_KANA_ROMAN_RE` (fullwidth Ⅰ-Ⅹ
at end OR followed by `[\s][～〜~]` after kana/kanji). Both run after
`stripPromoTail` and are gated by `!wasQuoteExtracted`.

When you add a sibling, regenerate the golden fixture and skim the
diff. Foot-guns to protect against:

- **Course/subject codes** (`数学Ⅰ`, `情報Ⅰ`): preserved by the dual
  end-of-string + `[\s][～〜~]`-tilde lookahead — subject codes are
  followed by free-form text, not a tilde-wrapped subtitle.
- **Foreign trailing digits** (`ロボコップ３`, `ロッキーⅡ`): preserved
  by `wasQuoteExtracted` because they're inside `「…」`.
- **ASCII tails** (`Test Ⅱ`, `iPhone 15 Pro`): preserved by the
  `(?<=[\u3040-\u30FF\u4E00-\u9FFF])` lookbehind.

### Whitelist judgement

`BLOCK_PREFIXES` / `QUOTED_HOST_PREFIX_RE` entries are graded by what
each entry covers and whether it could collide with a real TVDB show:

| Status | What | Example |
|---|---|---|
| ✅ Always OK | Structural rules content-agnostic | `[新]` flag-bracket strip, zenkaku ⟷ hankaku fold |
| ✅ Preferred for new fixes | Single general regex covering a class | `[日月火水木金土]\d+` (slot codes) |
| ⚠️ Almost never OK | Per-literal entries | `日曜劇場`, `金曜ロードショー` (inherited tech-debt) |

Per-literal additions only if there's no general regex that subsumes
it AND the literal genuinely cannot be a TVDB show name.

The `whitelist complexity guards` tests in `matchService.test.ts`
enforce: `BLOCK_PREFIXES.length <= SNAPSHOT_LIMIT` and `general regexes
>= 2`. Bumping the snapshot is intentional and forces a review.

## Step 4: add a regression test

Pick the test file based on *which layer you touched* — **touch ≠
primary fix**. Even if your primary fix is at one layer, any regex or
constant you modified in another layer also needs an explicit lock.
Golden fixtures are sanity checks, not substitutes for direct tests.

| You modified | Test file |
|---|---|
| `findEpisodeForProgram` / `parseTitleEpisodeNumber` / cascade | `findEpisodeForProgram.test.ts` (group per show under one `describe`) |
| `normalizeTitle` / `BLOCK_PREFIXES` / `QUOTED_HOST_PREFIX_RE` / `CUT_AT_*_RE` / strip rules | `matchService.test.ts` (add to `borderline` array) |
| Both layers | tests in **both** files — common pitfall: adding a counter glyph (`席`/`輪`/`食目`) to four sibling regexes but only testing the cascade |

A negative test (input the regex must NOT touch) is especially valuable
when you extend a prefix whitelist or strip rule — see `ドラマ・…`
preservation alongside `アニメ[A-Z]・` as a template.

Test data convention:
- Use the program's real `title` and `start_at` (UTC ISO) — test is
  self-documenting.
- Build `episodes` from the Step 1 cache dump.
- Comment the test with the source `programs.id`.
- `findEpisodeForProgram` returns `{ s, e, name? } | null`; no `aired`.
- For "no match" expected outcome: `assert.equal(hit, null)`.

## Step 5: run the suite

From `server/`:

```sh
node --import tsx --test src/services/findEpisodeForProgram.test.ts
node --import tsx --test src/services/matchService.test.ts
npm run typecheck
npm run test:golden
```

All four must be green. `matchService.test.ts` carries the whitelist
complexity guards — they fire if `BLOCK_PREFIXES` grew.

**If you touched the normaliser** (anything in `BLOCK_PREFIXES`,
`QUOTED_HOST_PREFIX_RE`, `STRIP_SUFFIX_RE`, `TRAILING_KANA_*_RE`, …),
the golden fixture is out of date. Regenerate and skim the diff:

```sh
npm run dump:golden-titles
git diff fixtures/normalize-titles.gold.json | head -200
```

Look for unintended strips. Commit the fixture alongside the code.

## Step 5.5: end-to-end verification

Synthetic tests can pass while the real program resolves wrong — the
test fixture may differ from the live TVDB cache (zenkaku/hankaku,
hidden control chars, missing showTitles). Always close the loop:

```sh
node --import tsx scripts/verify-match.ts '<PROGRAM_ID>'
```

The script calls `findEpisodeForProgram` exactly as `applyTvdbToPrograms`
does in production.

- **Result matches expected** → done.
- **Result null but program already has S/E** → cached from a previous
  run. Don't update the DB; confirm the existing S/E is also correct.

If the script still disagrees with your test, the test fixture is wrong
— adjust and re-verify. Don't ship until they agree. Do **not** UPDATE
the program row to fix the live state.

## Step 6: report back

1. Diagnosis (which step failed, why).
2. What changed (one-liner per file).
3. Test count delta.

Keep it under ~6 lines. Do **not** `git commit` — standing rule.

## Things to avoid

- DB writes (no UPDATE/INSERT).
- Show-specific regexes / tvdbId guards / show-name string checks.
- Touching `app/src/api/epghub.gen.ts` or `server/openapi.yaml`.
- `npm test` / `npm run test:e2e` (slow, DB-dependent — Step 5's four
  commands are sufficient).
- Committing changes.
