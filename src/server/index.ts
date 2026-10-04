import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './app';
import { bootstrap, loadEnvFile } from './bootstrap';
import { loadConfig } from './config';
import { startScheduler } from './pipeline/scheduler';

/** Serve the built SPA (single deployable) from an app. */
function mountClient(app: Hono): void {
  const clientDir = path.resolve('dist/client');
  if (!fs.existsSync(path.join(clientDir, 'index.html'))) return;
  const indexHtml = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
  app.use('/assets/*', serveStatic({ root: './dist/client' }));
  app.use('/favicon.svg', serveStatic({ root: './dist/client' }));
  app.get('*', (c) => c.html(indexHtml));
}

async function main() {
  loadEnvFile();
  const port = loadConfig().port;
  // Free hosting tiers sleep when idle. Open the port at once and answer with a friendly
  // "starting" state while the database connection and migrations are prepared, so the
  // browser shows "waking up" instead of hanging.
  const starting = new Hono();
  starting.all('/api/*', (c) => c.json({ error: 'GovCheck is starting up. This takes up to a minute after a period of inactivity.', starting: true }, 503));
  mountClient(starting);
  let active: Hono = starting;
  const server = serve({ fetch: (req, env) => active.fetch(req, env), port });

  const deps = await bootstrap();
  const { config, log, db } = deps;
  const app = createApp(deps);
  mountClient(app);
  active = app;
  log.info(`API listening on http://localhost:${port} (database: ${db.kind}${db.kind === 'pglite' ? ` at ${config.pgliteDir}` : ''})`);
  log.info(
    `SAM.gov API key: ${config.samApiKey ? 'configured' : 'NOT configured'} · Anthropic: ${config.anthropicApiKey ? 'configured' : 'not configured (AI features off)'} · In-process scheduler: ${config.schedulerEnabled ? 'on' : 'off'}`,
  );

  const stopScheduler = config.schedulerEnabled ? startScheduler(deps, log.child('scheduler')) : () => undefined;

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down…`);
    stopScheduler();
    server.close();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
