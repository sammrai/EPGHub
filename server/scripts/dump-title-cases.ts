// Dump every distinct program title from the live DB along with its current
// `normalizeTitle()` output into `server/fixtures/normalize-titles.gold.json`.
//
// The committed fixture is what `src/services/matchService.golden.test.ts`
// replays, so future regex tweaks in `normalizeTitle` produce a visible diff
// across the whole corpus — not just the 488 curated cases in
// `matchService.test.ts`.
//
// Usage:
//   tsx scripts/dump-title-cases.ts
// or via npm script:
//   npm run dump:golden-titles

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc } from 'drizzle-orm';
import { db, queryClient } from '../src/db/client.ts';
import { programs } from '../src/db/schema.ts';
import { normalizeTitle } from '../src/services/matchService.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '..', 'fixtures', 'normalize-titles.gold.json');

async function main(): Promise<void> {
  // SELECT DISTINCT title FROM programs ORDER BY title
  const rows = await db
    .selectDistinct({ title: programs.title })
    .from(programs)
    .orderBy(asc(programs.title));

  const cases: Array<{ raw: string; normalized: string }> = [];
  let skipped = 0;
  for (const r of rows) {
    const raw = r.title;
    if (raw === null || raw === undefined || raw === '') {
      skipped++;
      continue;
    }
    cases.push({ raw, normalized: normalizeTitle(raw) });
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(cases, null, 2) + '\n');

  console.log(`distinct titles: ${rows.length}`);
  console.log(`skipped (empty/null): ${skipped}`);
  console.log(`written: ${cases.length} entries -> ${outPath}`);
}

try {
  await main();
  await queryClient.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  console.error(err);
  await queryClient.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
