import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp, seedDev } from './app.ts';
import { boss } from './jobs/queue.ts';
import { registerWorkers } from './jobs/workers.ts';
import { seedDbIfEmpty } from './db/seed.ts';
import { scheduleService } from './services/scheduleService.ts';
import { matchService } from './services/matchService.ts';
import { epgLiveService } from './services/epgLiveService.ts';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

// Start pg-boss before any code can enqueue — reserveService.create() sends
// record.start/stop jobs when a reserve is accepted.
await boss.start();
await registerWorkers(boss);

// Populate Drizzle-backed tables from fixtures on first boot only.
await seedDbIfEmpty();

// Seed the env-driven Mirakurun channel source if no rows exist yet so
// existing installs keep working without opening the settings UI.
try {
  const { channelSyncService } = await import('./services/channelSyncService.ts');
  await channelSyncService.seedFromEnvIfEmpty();
} catch (err) {
  console.warn('[boot] channel source env seed failed (continuing):', err);
}

// Hydrate the programs table synchronously on boot so /schedule and seedDev
// have data immediately. The cron worker also runs this every 10 minutes.
try {
  const { count } = await scheduleService.refresh();
  const { resolved, missed } = await matchService.enrichUnmatched();
  console.log(`[boot] epg hydrate: programs=${count} tvdb resolved=${resolved} missed=${missed}`);
} catch (err) {
  console.warn('[boot] epg hydrate failed (continuing):', err);
}

await seedDev();

// Subscribe to Mirakurun's /events/stream so program extensions (EIT[p/f]
// updates) flow into reserves in near real-time. The polling fallback in
// QUEUE.EPG_LIVE_POLL covers the SSE-down case.
try {
  await epgLiveService.start();
} catch (err) {
  console.warn('[boot] epgLiveService.start failed (continuing with polling only):', err);
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`epghub api listening on http://localhost:${info.port}`);
  console.log(`  OpenAPI: http://localhost:${info.port}/openapi.json`);
  console.log(`  Docs:    http://localhost:${info.port}/docs`);
  console.log(`  Workers: record.start record.stop encode epg.refresh rule.expand`);
});

// Flush gracefully on SIGTERM/SIGINT so in-flight jobs aren't re-poached
// by other workers on restart and active recordings are closed cleanly.
async function shutdown(sig: string): Promise<void> {
  console.log(`[${sig}] shutting down...`);
  try { await epgLiveService.stop(); } catch (e) { console.warn('[shutdown] epgLive stop failed:', e); }
  try {
    const { stopAllRecordings } = await import('./recording/recorder.ts');
    await stopAllRecordings();
  } catch (e) { console.warn('[shutdown] recorder stop failed:', e); }
  try { await boss.stop({ graceful: true }); } catch (e) { console.warn(e); }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
