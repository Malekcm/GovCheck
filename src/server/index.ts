import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { bootstrap } from './bootstrap';
import { startScheduler } from './pipeline/scheduler';

async function main() {
  const deps = await bootstrap();
  const { config, log, db } = deps;
  const app = createApp(deps);

  // Serve the built SPA in production (single deployable).
  const clientDir = path.resolve('dist/client');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    const indexHtml = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
    app.use('/assets/*', serveStatic({ root: './dist/client' }));
    app.use('/favicon.svg', serveStatic({ root: './dist/client' }));
    app.get('*', (c) => c.html(indexHtml));
  }

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info(`API listening on http://localhost:${info.port} (database: ${db.kind}${db.kind === 'pglite' ? ` at ${config.pgliteDir}` : ''})`);
    log.info(`SAM.gov API key: ${config.samApiKey ? 'configured' : 'NOT configured'} · Anthropic: ${config.anthropicApiKey ? 'configured' : 'not configured (AI features off)'} · Scheduler: ${config.schedulerEnabled ? 'on' : 'off'}`);
  });

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
