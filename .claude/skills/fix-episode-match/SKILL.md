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

### Don't pick — enumerate (with API-load awareness)

When the input is ambiguous, don't silently commit to one
interpretation in a way that grows per-case. The matcher already has
scoring (`scoreOf` in `matchService.ts`) and `findEpisodeForProgram`
has a four-step signal cascade; pre-processing should feed them, not
pre-empt them. **But fan-out has a cost** — every extra candidate the
auto-matcher tries is one more `tvdbService.search` call against a
rate-limited API. The principle is "enumerate"; the implementation
choice is whether to enumerate *at the regex level* (one regex covers
a class, no extra API calls) or *at the search level* (multiple
candidates per missed primary, extra API calls).

Prefer the regex-level form when the class can be captured by a
single general regex with low collision risk against real TVDB show
names. Fall back to search-level fan-out only when no general regex
works — or as the safety net for unknown future patterns. A growing
*list of literal regexes* is the same anti-pattern as a growing list
of literal strings.

You're in the wrong shape when:
- The fix grows an enumerated list **per literal** — adding `日5`,
  then later `土6`, then `月8`. Each addition only fixes one case;
  list grows without bound.
- You're confident the answer is "the part before / inside / after X"
  but all three are plausible. The fix should not commit to one.
- The fix needs a *show-specific* literal guard (`if title.includes
  ('満員御礼')`, hardcoded TVDB id). One show, one bandage; no
  generalisation.

Where the right level lives in this codebase:
- **Show-name resolution** → `BLOCK_PREFIXES` / `QUOTED_HOST_PREFIX_RE`
  in `matchService.ts`. Adding a *single general regex* to
  `BLOCK_PREFIXES` is the cheapest way to absorb a structural class
  of broadcaster shorthand; the existing single-fallback
  (`key.split(/\s+/)[0]`) in `enrichUnmatched` covers the
  documentary-style "show name + space + subtitle" case.
- **Trailing structural sequel markers** → check
  `TRAILING_KANA_DIGIT_RE` / `TRAILING_KANA_ROMAN_RE` first. If your
  case is "broadcaster appends a sequel/season marker to a Japanese
  show name and TVDB carries the no-marker canonical form", a sibling
  regex on the same shape is the right move — no API cost. **Look
  for these precedents BEFORE reaching for search-level fan-out;
  every search-level candidate is one extra rate-limited TVDB call.**
- **Per-airing episode resolution** → `findEpisodeForProgram`'s
  four-step cascade. Cheap to extend (no API cost), so prefer
  extending the cascade or having an existing step emit multiple
  internal candidates.

### Calibrating a trailing-marker regex

The existing siblings are `TRAILING_KANA_DIGIT_RE` (1 hankaku digit
at end-of-string after kana/kanji) and `TRAILING_KANA_ROMAN_RE`
(fullwidth Ⅰ-Ⅹ at end OR followed by `[\s][～〜~]` after kana/kanji).
Both run after `stripPromoTail`, both are gated by
`!wasQuoteExtracted` (so titles extracted from `「…」` keep the
marker — the sub-quote is the canonical form).

When you add a new sibling, verify the regenerated golden fixture
diff for unintended strips. The known foot-guns:

- **Course/subject-level designations**: `数学Ⅰ` / `情報Ⅰ` /
  `英語コミュニケーションⅡ` (Japanese high-school subject codes,
  not sequels). The end-of-string lookahead AND the
  `[\s][～〜~]`-tilde lookahead together protect these — a subject
  designation is followed by free-form text (not a tilde-wrapped
  subtitle). Keep both lookaheads narrow.
- **Foreign-title trailing digits**: `ロボコップ３`, `ロッキーⅡ` —
  preserved by `wasQuoteExtracted` because they're inside `「…」`.
- **ASCII-tail trailing markers**: `Test Ⅱ`, `iPhone 15 Pro` —
  preserved by the `(?<=[\u3040-\u30FF\u4E00-\u9FFF])` lookbehind.
- **Year tags / serial counts**: `ハチ公20` (2-digit, end), `桜2002`
  (4-digit year). The digit regex is single-digit only; the Roman
  regex doesn't match Arabic numerals. Both safe.

### Whitelist judgement

Whitelists in `BLOCK_PREFIXES` / `QUOTED_HOST_PREFIX_RE` are not
categorically banned. The test is *what each entry covers* and
*whether it could collide with a real TVDB show*:

- **Always OK**: structural rules that strip a syntactic class
  regardless of content (`[新]` and other `[…]` flag-bracket strips,
  zenkaku ⟷ hankaku folding, half ⟷ full punctuation). Content-
  agnostic, no candidate lost.
- **Preferred for new fixes**: a *single general regex* covering a
  structural class of broadcaster shorthand — e.g. `[日月火水木金土]\d+`
  for weekday+hour slot codes (日5 / 月9 / 木10 / …). One regex
  absorbs the whole class so the list doesn't grow with each new
  network's slot label. Acceptable when the regex is unlikely to
  collide with a real TVDB show name. If you can't rule out collision
  (a show literally named `木7`, or a sumo programme like `満員御礼`
  that resembles a show name), don't add it — prefer search-level
  fan-out instead.
- **Almost never OK for new fixes**: per-literal entries (`日曜劇場`,
  `金曜ロードショー`, the existing list). Inherited tech-debt; new
  entries of this shape should be argued against. Only land one if
  there's no general regex that subsumes it AND the literal genuinely
  cannot be a TVDB show.

The `matchService whitelist complexity guards` tests in
`matchService.test.ts` enforce this:
- `BLOCK_PREFIXES.length <= SNAPSHOT_LIMIT` — bumping is intentional
  and forces a review.
- General-regex entries `>= 2` — if a literal addition pushes ratio
  toward "all literals", the test forces a re-think.

When you add to `BLOCK_PREFIXES`, expect to update the snapshot AND
justify in the PR. That's the friction by design.

## Step 4: add a regression test

Pick the test file based on *which layer* you fixed:

- **Fix in `findEpisodeForProgram` / `parseTitleEpisodeNumber` / signal
  cascade** → `findEpisodeForProgram.test.ts`. Group multiple cases for
  the same show under one `describe('findEpisodeForProgram — <show>
  regression case')`.
- **Fix in `normalizeTitle` / `BLOCK_PREFIXES` /
  `QUOTED_HOST_PREFIX_RE` / strip rules** → `matchService.test.ts`.
  Add a `Case` to the `borderline` (or other relevant) array.
- **Both layers touched** → add tests to both files; each file locks
  the layer it owns.

Use the **exact program title and start time from the DB** (test is
self-documenting — anyone reading it sees which real-world EPG
artefact it locks down).

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
node --import tsx --test src/services/matchService.test.ts
npm run typecheck
npm run test:golden
```

All four must be green before you report done. `matchService.test.ts`
carries both the normaliser cases and the **whitelist complexity
guards** (`BLOCK_PREFIXES.length` snapshot, regex/literal ratio) — if
your fix grew the whitelist, the snapshot test fails here first.

If any unrelated test fails, investigate — your normalisation/regex
change may have broken a neighbouring case.

### When the normaliser changed

If your fix touches `normalizeTitle` (incl. anything in
`BLOCK_PREFIXES`, `QUOTED_HOST_PREFIX_RE`, `STRIP_SUFFIX_RE`,
`TRAILING_KANA_DIGIT_RE`, …), the golden fixture in
`server/fixtures/normalize-titles.gold.json` is now out of date and
`npm run test:golden` will fail. Regenerate then review the diff:

```sh
npm run dump:golden-titles
git diff fixtures/normalize-titles.gold.json | head -200
```

Skim the diff for unintended changes (titles you didn't expect to
move). Commit the regenerated fixture alongside your code change.

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
