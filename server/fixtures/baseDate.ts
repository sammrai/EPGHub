// Dev fixtures are anchored to a fixed "today" so programs, reserves and
// "now recording" tell a coherent story. Change via FIXTURE_DATE env or
// FIXTURE_NOW env for mock time.
const iso = (d: string, hhmm: string) => `${d}T${hhmm}:00+09:00`;

export const FIXTURE_DATE = process.env.FIXTURE_DATE ?? '2026-04-19';
export const FIXTURE_NOW_ISO = process.env.FIXTURE_NOW ?? iso(FIXTURE_DATE, '20:12');

export function at(hhmm: string): string {
  return iso(FIXTURE_DATE, hhmm);
}

export function fixtureNow(): Date {
  return new Date(FIXTURE_NOW_ISO);
}
