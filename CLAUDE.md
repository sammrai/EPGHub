# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 会話ガイド

日本語で会話して

## Repository layout

Two top-level workspaces, each with its own `package.json`:

- **`server/`** — the only backend. Hono + `@hono/zod-openapi`, Drizzle (Postgres), pg-boss worker queue. Owns recording lifecycle, TVDB matching, EPG hydration. Exposes `/openapi.json` + `/docs` + `openapi.yaml`.
- **`app/`** — React 18 + Vite frontend. Thin UI against the server. Types are **generated** from `server/openapi.yaml` into `src/api/epghub.gen.ts`; do not edit that file by hand. Vite proxies `/api/*` → server (default `:3000`).

Supporting files: `docker-compose.yml` (Postgres for host-machine dev), `.devcontainer/postCreate.sh` (installs Postgres, runs migrations, npm installs).

## Common commands

Run from inside the relevant workspace:

```sh
# server/
npm run dev              # tsx watch src/index.ts — Hono API on :3000
npm run typecheck        # tsc -p . --noEmit
npm run gen:openapi      # write openapi.yaml (commit as-is; app/ consumes it)
npm run db:generate      # drizzle-kit generate (after schema.ts changes)
npm run db:migrate       # apply migrations in server/drizzle/
npm run db:studio        # Drizzle Studio

npm test                 # unit tests (node --test via tsx)
npm run test:e2e         # API scenarios (spins up the app against Postgres)
npm run test:mirakurun   # Mirakurun client integration tests
npm run test:golden      # matchService title-normalization golden cases
# Run a single file:
node --import tsx --test src/services/matchService.test.ts

# app/
npm run dev              # Vite on :5173, /api → :3000
npm run gen:api          # regenerate src/api/epghub.gen.ts from ../server/openapi.yaml
npm run build            # tsc -b && vite build
```

**Whenever you change zod schemas or routes in `server/`**: run `npm run gen:openapi` in `server/` **and** `npm run gen:api` in `app/` so the frontend types stay in sync. Commit both `openapi.yaml` and `epghub.gen.ts`.

## Architecture

### Server request flow
`src/index.ts` boots pg-boss, registers workers, hydrates programs from Mirakurun, seeds dev data, subscribes to Mirakurun SSE for program-extension events, then starts the HTTP server. `src/app.ts` assembles the `OpenAPIHono` app and mounts routers.

- `routes/*.ts` — one per resource (`channels`, `schedule`, `programs`, `recordings`, `rules`, `tvdb`, `tuners`, `system`, `rankings`, `admin`). Each uses `createRoute` + `app.openapi(...)` so the OpenAPI spec is derived from the same zod schemas.
- `schemas/*.ts` — zod definitions with `.openapi(...)` metadata. Single source of truth for TS types, runtime validation, and the OpenAPI doc.
- `services/*.ts` — domain logic, no HTTP concerns. Talks to Drizzle and other services. Tests sit next to the service (`*.test.ts`).
- `db/schema.ts` + `drizzle/*.sql` — Postgres schema. Schema edits → `db:generate` → edit migration if needed → `db:migrate`.
- `jobs/queue.ts` + `jobs/workers.ts` — pg-boss queues (`record.start`, `record.stop`, `encode`, `epg.refresh`, `rule.expand`, `ranking.sync`, `epg.live.poll`, `thumbnail`, `disk.sweep`). Workers run in the same process as the HTTP server.
- `recording/` — `recorder.ts` (lifecycle: start/stop/finalize), `encoder.ts`, `encodePresets.ts`, `dropChecker.ts`, `thumbnailer.ts`, `plexNaming.ts`.
- `integrations/mirakurun` — live tuner source (channels, schedule, SSE program events). Without `MIRAKURUN_URL` the server runs against `fixtures/`.
- `integrations/tvdb` — v4 client with disk-backed response cache (`TVDB_CACHE_DIR`).
- `integrations/m3u` + `integrations/jcom` — pluggable channel/ranking sources.

### Key service boundaries
- **`scheduleService`** owns the `programs` table; `programs.id = "${ch}_${startAt}"` so upserts across EPG refreshes are stable.
- **`recordingService`** owns the unified `recordings` row that covers the whole lifecycle (`scheduled` → `recording` → `encoding` → `ready` / `failed` / `cancelled`). After the R0 unification there is no separate "reserve" table. `scheduledOrLive` vs `ready` filters pick the reserves vs library views in the UI.
- **`matchService`** normalizes titles and resolves programs → `tvdb_entries`. Golden tests lock the normalization behaviour. See "TVDB cache strategy" below for the show/episode freshness model.
- **`ruleExpander`** walks enabled rules against the current schedule and emits reserves via `recordingService`.
- **`epgLiveService`** subscribes to Mirakurun `/events/stream` so program extensions flow into active reserves in near real-time; `QUEUE.EPG_LIVE_POLL` is the 1-minute fallback.
- **`tunerAllocator`** + **`capacityService`** guard against conflicts and disk exhaustion respectively.

### Frontend
`src/App.tsx` is the router + orchestrator. State flows:

1. `lib/hooks.ts` — SWR-style hooks (`useScheduleRange`, `useRecordings`, `useRules`, `useTuners`, `useSystem`, `useTvdbCatalog`, …) call `api/epghub.ts`.
2. `lib/adapters.ts` — maps API types (`ApiProgram`, `ApiRecording`, …) to the UI's domain shape in `data/types.ts`.
3. `components/` — `Shell` (header/sidebar), `Grid`/`Timeline`/`Agenda` views, `Modal` (reserve modal), `Pages` (Library/Reserves/Discover/Settings).
4. URL state: `?date=YYYY-MM-DD` and `?modal=<programId>`; the router is the source of truth so the back button closes modals. Date handling uses a **JST 05:00 broadcast-day boundary** (see `jstTodayYmd` in `App.tsx`).

`data/channels.ts` + `data/channelStore.ts` model channels as DB-backed dynamic data; do **not** reintroduce a static `CHANNELS` constant.

## TVDB cache strategy

Single source of truth: TVDB v4 API. The `FileCache` (`${TVDB_CACHE_DIR}/{search,detail}/`) is the only cache layer — there is **no DB-side cache of TVDB metadata** (`tvdb_entries.episodes` was eliminated; the table holds only the relational anchor + identifying metadata).

Misses are split into two classes with different defenses:

- **Class A — search-level miss** (the show is not on TVDB at all).
  Defense: `title_overrides` writes a `null` row with `user_set=false` and a 30-day TTL (`AUTO_REMATCH_TTL_MS`). `enrichUnmatched` skips TVDB search while the override is fresh, so minor / un-indexed shows do not flood the API.

- **Class B — episode-level miss** (show is matched, but the episode is missing from the cached episode list — usually because TVDB added new episodes since the show was first matched).
  Defense: reactive refresh enqueued from `applyTvdbToPrograms` when S/E resolves to null and the title carries an episode marker. The queue uses `pg-boss singletonKey: tvdb-eps:${tvdbId}` with a 4-hour cooldown so repeated misses against the same show collapse to one refresh. The refresh calls `tvdbService.getSeriesEpisodes(id, { forceRefresh: true })`. A daily safety-net cron catches misses without a marker.

`FileCache` TTL for series detail (which carries the episode list inline) is status-driven and encoded per-entry in the cache envelope: `continuing` / `upcoming` → **2 days**, `ended` / `cancelled` → **30 days**, unknown → 7 days. The writer (`client.getSeriesExtended`) picks the TTL from the fetch response's `status.name` so readers don't need to know the policy. The Class B reactive refresh queue's `singletonKey` cooldown is **4 hours** per show — independent timer from the TTL: TTL controls when cache auto-expires, cooldown controls how often a force-refresh can fire.

Deferred (production-only concern): the default `TVDB_CACHE_DIR` is `/tmp/epghub/tvdb` which is wiped on container restart. Once the FileCache is the only persistence layer for TVDB metadata, a restart re-fetches everything until the cache warms up. Point `TVDB_CACHE_DIR` at a persistent volume in production deployments.

`forceRefresh: true` on a tvdbService getter busts only the FileCache layer for that key — TTL-aware callers (above) drive when it fires.

## Project conventions

- **Schema-driven**: zod → TS types → runtime validation → OpenAPI. If a route accepts or returns something, add a zod schema first and let `app.openapi(route, handler)` do the rest.
- **No mock data under `src/`.** `fixtures/` directories (both `server/fixtures/` and `app/fixtures/`) hold dev-only sample data and must not be imported from production code paths.
- **ISO-8601 everywhere** for times on the wire. The UI derives display strings (`HH:MM`, broadcast-day labels) locally.
- **Viewing/playback features are intentionally out of scope.** Everything is recording-focused.
- **TVDB integration is pluggable.** `FixtureTvdbProvider` is the default without `TVDB_API_KEY`; the real v4 client swaps in when the key is set.

## Environment (server/.env)

- `DATABASE_URL` — Postgres URL. Dev default matches `docker-compose.yml`: `postgresql://epghub:epghub@localhost:5432/epghub`.
- `PORT` — API port (default `3000`).
- `MIRAKURUN_URL` — when set, `/channels` and `/schedule` pull from Mirakurun; otherwise fixtures drive everything. The dev seed (`seedDev()` in `app.ts`) is skipped when this is set, since live programs don't carry fixture series keys.
- `TVDB_API_KEY`, `TVDB_CACHE_DIR` — TVDB v4 auth + response cache.
- `RECORDING_DIR` — output directory (defaults to `server/.recordings`). `GET /system` reports storage from a statfs on this path.

## Testing notes

- Unit tests use `node --test` with `tsx`. They live next to the module under test and import real dependencies where cheap; database tests expect a reachable `DATABASE_URL`.
- E2E tests (`src/e2e/api-scenarios.test.ts`) boot the full Hono app against Postgres and walk multi-step API scenarios. Do not mock the database — prior incidents showed mock/prod divergence masking migration bugs.
- The golden title-normalization corpus is regenerated with `npm run dump:golden-titles`; review diffs before committing.

## Things to avoid

- Don't broad-kill `node` or `tsx` processes (e.g. `pkill -f tsx`). The devcontainer runs the VS Code server the same way; kill by PID or by a narrow path pattern.
- Don't add an `/api/*` surface that bypasses the server — the browser talks to `server/` only. Mirakurun stays server-side.
- Don't hand-edit `app/src/api/epghub.gen.ts` or `server/openapi.yaml`; regenerate them.
