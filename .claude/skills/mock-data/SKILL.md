---
name: mock-data
description: Use when the user asks to add or edit sample/mock data for the GitHub Pages UI deploy — typically things like "番組表のサンプルを増やして", "TVDB 紐付きをXXに追加", "録画中の番組を増やして", "発見タブの○○ジャンルにサンプル", or "モック UI に○○を出して". All mock data lives in `app/src/mocks/data.ts`; the `window.fetch` shim in `install.ts` is auto-generated from it.
---

# Mock sample data workflow

The GitHub Pages deploy (https://sammrai.github.io/EPGHub/) runs the
real React app against an in-bundle fetch shim. Every `/api/*` response
resolves from constants/generators in `app/src/mocks/data.ts`. No
Postgres, no server — change this one file and the Pages site changes
after CI.

## Files that matter

- **`app/src/mocks/data.ts`** — SCHEDULE, RANKING_SEEDS, TVDB_CATALOG_RAW, recording generator. Single source of truth; ~90% of edits land here.
- **`app/src/mocks/handler.ts`** — URL dispatcher. Only edit when adding a brand-new `/api/*` endpoint to mock.
- **`app/src/mocks/install.ts`** — window.fetch override. Don't touch; it's generic.
- **`.github/workflows/pages.yml`** — builds + deploys on push to main. No edits needed.

## Mental model: the 2×2×2 demo matrix

Eight `DemoCase` labels describe every meaningful state a program can be in:

```
{series | movie} × {tvdb-linked | plain} × {being-recorded | free}
```

The UI renders these differently (TVDB chip, recording badge, "add rule"
button, etc.), so keep coverage balanced: aim for **2–3 tagged slots per
case** out of the ~200 filler programs. Under 10 total tagged looks too
sparse; over 40 drowns the filler.

## How to add a new program

1. Pick a channel in `SCHEDULE` (`nhk-g`, `mx`, `bsp`, etc.) and insert a `Slot` at the time-of-day position you want. Durations are relative and rescaled to fill 24h per channel, so don't worry about exact math.
2. If the program represents one of the 8 demo cases, add `demo: '<case>'`.
3. If the case is `*-tvdb-*`, also add `tvdbId: <id>` pointing at an entry in `TVDB_CATALOG_RAW`.
4. If the case is `*-rec`, the recording row is emitted automatically by `makeRecordings`. State comes from `stateByCase` inside that function — edit it only when you want a different state per case.

Example:

```ts
// inside SCHEDULE['nhk-g']:
{ dur: 55, title: 'NHKスペシャル', genre: 'doc',
  series: 'nhk-special', ep: '#1082',
  demo: 'series-tvdb-rec', tvdbId: 10002 },
```

## How to add a new TVDB entry

Append to `TVDB_CATALOG_RAW`. Use distinct id ranges so conflicts are
obvious:
- **10000s** → series
- **20000s** → movies

Series need `totalSeasons / currentSeason / currentEp / totalEps /
status`; movies need `runtime / director / rating`. Copy an existing
entry and adjust.

## How to adjust the Discover tab

Per-genre rankings live in `RANKING_SEEDS`. Keys are the `ApiRankingGenre`
values: `all`, `drama`, `anime`, `doc`, `movie`, `var`, `news`, `edu`,
`sport`, `music`. Each entry is a `RankingSeed`:

- `tvdbId: 10001` — the item is TVDB-linked (Discover shows the add-rule chip)
- `tvdbId: null` — the item is plain
- Keep **≥ 1 tvdb-linked** item in every genre that has matching series/movies in the catalog, or the Discover tab shows nothing to link.

`rankingsForGenre(g)` resolves seeds against `TVDB_CATALOG_RAW` at call
time — no syncing needed.

## How "currently recording right now" is derived

`nowRecording()` returns every slot tagged `series-tvdb-rec` (and only
that case). If you want a drama or movie to show up as on-air, tag its
slot with `series-tvdb-rec` or extend `nowRecording()` to include more
cases.

## Verify locally

```
cd app && npm run build:mock
```

Builds both production bundles and writes `app/dist/`. A quick data
sanity check:

```
cd app && npx tsx -e '
import { programsForDate, recordingsList, nowRecording, rankingsForGenre, defaultToday } from "./src/mocks/data.ts";
const d = defaultToday();
const progs = programsForDate(d);
const recs = recordingsList(d);
console.log("total:", progs.length, "tvdb:", progs.filter(p => p.tvdb).length);
console.log("recordings:", recs.length, "nowRec:", nowRecording(d).length);
'
```

The mock chunk is tree-shaken out of regular `npm run build`; only
`build:mock` (and the `pages` workflow) bundle it.

## Gotchas

- `programsForDate` resets `DEMO_PROGRAM_IDS` at the top. Do not remove that reset — repeated calls (handler → schedule → recordings) would otherwise double-tag.
- `TVDB_CATALOG_RAW` must be declared **above** the schedule expander and ranking helpers. It's below `DEMO_PROGRAM_IDS` in the file. Moving it below the expander triggers a temporal-dead-zone runtime error.
- The types are deliberately loose (`as unknown as ApiXxx`). Don't fight the generated OpenAPI types — the UI only reads a subset of fields and strict typing here bought us TS errors with zero runtime benefit.
- SCHEDULE durations auto-scale to 1440 min per channel. It's safe to add more slots without recalculating — the last slot absorbs the remainder.

## Ship it

Commit `app/src/mocks/data.ts` (and `handler.ts` if you added an
endpoint). Push to `main`. `.github/workflows/pages.yml` rebuilds +
deploys to https://sammrai.github.io/EPGHub/ within ~90s. No manual
step is required — if the workflow file is untouched and CI goes green,
the site is updated.
