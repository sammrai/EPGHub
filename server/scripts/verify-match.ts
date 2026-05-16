import 'dotenv/config';
import { db } from '../src/db/client.ts';
import { programs, tvdbEntries } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
import { findEpisodeForProgram } from '../src/services/matchService.ts';

const programId = process.argv[2];
if (!programId) { console.error('usage: verify-match.ts <programId>'); process.exit(1); }

const [prog] = await db.select().from(programs).where(eq(programs.id, programId)).limit(1);
if (!prog) { console.error('program not found'); process.exit(1); }
console.log('program:', { id: prog.id, title: prog.title, start_at: prog.startAt.toISOString(), tvdb_id: prog.tvdbId, current_s: prog.tvdbSeason, current_e: prog.tvdbEpisode });

if (prog.tvdbId == null) { console.log('not linked to tvdb'); process.exit(0); }
const [entry] = await db.select().from(tvdbEntries).where(eq(tvdbEntries.tvdbId, prog.tvdbId)).limit(1);
if (!entry) { console.error('tvdb entry not found'); process.exit(1); }
const showTitles = [entry.title, entry.titleEn].filter((t): t is string => Boolean(t));
const episodes = entry.episodes ?? [];
const result = findEpisodeForProgram(episodes, prog.startAt.toISOString(), prog.title, showTitles, prog.desc);
console.log('showTitles:', showTitles);
console.log('findEpisodeForProgram result:', result);
process.exit(0);
