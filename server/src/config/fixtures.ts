// Centralised gate for fixture-backed demo data so there is one source of
// truth across seeds, runtime services, and the schedule hydrator.
//
// - `EPGHUB_FIXTURES=off` hard-disables fixtures, even without Mirakurun.
//   docker-compose.yml defaults to this so a deployed stack starts empty
//   instead of showing 34 sample programs + fake rules + fake tuners.
// - Default: fixtures are used when MIRAKURUN_URL is unset (dev UX). Setting
//   MIRAKURUN_URL turns them off implicitly (real data is available).
export function useFixtures(): boolean {
  if (process.env.EPGHUB_FIXTURES === 'off') return false;
  return !process.env.MIRAKURUN_URL;
}
