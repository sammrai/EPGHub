// Golden-fixture test for `normalizeTitle`.
//
// Replays `fixtures/normalize-titles.gold.json` — a snapshot of every
// distinct `programs.title` in the live DB at the time the fixture was
// generated, paired with the `normalizeTitle` output produced at that time
// (see `scripts/dump-title-cases.ts`).
//
// Run via: `npm run test:golden`. Excluded from `test:unit` because the
// fixture has thousands of entries and is too slow for routine CI runs.
//
// To regenerate after an intentional normalizer change:
//   npm run dump:golden-titles
// then inspect the git diff of the fixture before committing.

// `matchService.ts` imports `db/client.ts` at module load, which requires
// DATABASE_URL. Load `.env` before that transitive import fires. This matches
// how `matchService.test.ts` does it.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle } from './matchService.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'normalize-titles.gold.json'
);

interface GoldenCase {
  raw: string;
  normalized: string;
}

const cases: GoldenCase[] = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('normalizeTitle golden fixture', () => {
  for (const { raw, normalized } of cases) {
    assert.equal(
      normalizeTitle(raw),
      normalized,
      `normalizeTitle(${JSON.stringify(raw)}) diverged from fixture`
    );
  }
});
