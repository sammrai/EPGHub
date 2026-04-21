import { OpenAPIHono } from '@hono/zod-openapi';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { channelsRouter } from './routes/channels.ts';
import { scheduleRouter } from './routes/schedule.ts';
import { programsRouter } from './routes/programs.ts';
import { recordingsRouter } from './routes/recordings.ts';
import { rulesRouter } from './routes/rules.ts';
import { tvdbRouter } from './routes/tvdb.ts';
import { tunersRouter } from './routes/tuners.ts';
import { systemRouter } from './routes/system.ts';
import { rankingsRouter } from './routes/rankings.ts';
import { adminRouter } from './routes/admin.ts';
import { searchRouter } from './routes/search.ts';
import { recordingService } from './services/recordingService.ts';
import { scheduleService } from './services/scheduleService.ts';
import { useFixtures } from './config/fixtures.ts';

const DOC_META = {
  openapi: '3.1.0' as const,
  info: {
    version: '0.1.0',
    title: 'epghub API',
    description:
      '録画管理 API (epghub). 録画特化・TVDB 連携・視聴機能なし。'
      + ' スキーマ駆動設計で OpenAPI は zod から自動生成される。',
  },
  servers: [{ url: 'http://localhost:3000', description: 'dev' }],
};

export function createApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  app.use('*', logger());
  app.use('*', cors({ origin: '*' }));

  // Structured error responses — default Hono handler returns plain text on
  // 500 which hides the root cause from the browser devtools.
  app.onError((err, c) => {
    console.error('[onError]', err);
    return c.json(
      {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      500
    );
  });

  app.route('/', channelsRouter);
  app.route('/', scheduleRouter);
  app.route('/', programsRouter);
  app.route('/', recordingsRouter);
  app.route('/', rulesRouter);
  app.route('/', tvdbRouter);
  app.route('/', tunersRouter);
  app.route('/', systemRouter);
  app.route('/', rankingsRouter);
  app.route('/', adminRouter);
  app.route('/', searchRouter);

  app.doc('/openapi.json', DOC_META);
  app.get('/docs', (c) => c.html(SWAGGER_HTML));

  return app;
}

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>EPGHub API — Swagger UI</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.addEventListener('load', () => {
        window.ui = SwaggerUIBundle({
          url: '/openapi.json',
          dom_id: '#swagger-ui',
        });
      });
    </script>
  </body>
</html>`;

export { DOC_META };

// Dev seed: pre-populate recordings for fixture programs so the UI has a
// non-empty state out of the box. Skipped when fixtures are disabled
// (EPGHUB_FIXTURES=off) or Mirakurun is wired up — real programs don't
// carry our fixture series keys.
export async function seedDev(): Promise<void> {
  if (!useFixtures()) return;

  const programs = await scheduleService.list();
  const wanted = new Set([
    'taiga-2026', 'nichigeki-2026q2', 'darwin', 'nhk-special',
    'doc72h', 'itteq', 'sazae', 'sekai-isan', 'sekkaku',
    'euph-2026', 'kaiju8', 'potsun', 'precure', 'pokemon',
    'jonetsu', 'maruko', 'tonari-totoro', 'mlb',
  ]);
  const reserved = new Set((await recordingService.list()).map((r) => r.programId));
  for (const p of programs) {
    if (p.series && wanted.has(p.series) && !reserved.has(p.id)) {
      try {
        await recordingService.create({
          programId: p.id,
          priority: 'medium',
          quality: '1080i',
          keepRaw: false,
          marginPre: 0,
          marginPost: 30,
          source: { kind: 'once' },
          force: true,
        });
      } catch {
        // ignore — dev seed is best-effort
      }
    }
  }
}
