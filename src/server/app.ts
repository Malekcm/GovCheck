import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ZodError } from 'zod';
import type { AppConfig } from './config';
import type { Db } from './db';
import type { RequestBudget } from './connectors/types';
import type { HttpClient } from './lib/http';
import { errorMessage, type Logger } from './lib/logger';
import { registerBdRoutes } from './routes/bd';
import { registerCompanyRoutes } from './routes/company';
import { registerIntelRoutes } from './routes/intel';
import { registerMetaRoutes } from './routes/meta';
import { registerOpportunityRoutes } from './routes/opportunities';
import { registerSourceRoutes } from './routes/sources';
import { registerSearchRoutes } from './routes/search';

export interface AppDeps {
  db: Db;
  config: AppConfig;
  http: HttpClient;
  log: Logger;
  budget: RequestBudget;
}

export class HttpProblem extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_COOKIE = 'goi_session';

function sign(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSession(config: AppConfig): string {
  const exp = Date.now() + 30 * 86_400_000;
  const payload = `v1.${exp}`;
  return `${payload}.${sign(config.sessionSecret, payload)}`;
}

export function verifySession(config: AppConfig, token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(config.sessionSecret, payload);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(parts[1]) > Date.now();
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpProblem(400, 'Request body must be valid JSON.');
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { config } = deps;

  app.onError((err, c) => {
    if (err instanceof HttpProblem) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) return c.json({ error: 'Invalid input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    deps.log.error(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: errorMessage(err) }, 500);
  });

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });

  // Auth endpoints (always reachable)
  app.get('/api/auth/me', (c) => c.json({ authRequired: !!config.appPassword, authenticated: !config.appPassword || verifySession(config, getCookie(c, SESSION_COOKIE)) }));
  app.post('/api/auth/login', async (c) => {
    if (!config.appPassword) return c.json({ ok: true });
    const body = await readJson<{ password?: string }>(c);
    if (!body.password || !safeEqual(body.password, config.appPassword)) throw new HttpProblem(401, 'Incorrect password.');
    setCookie(c, SESSION_COOKIE, issueSession(config), { httpOnly: true, sameSite: 'Lax', secure: config.nodeEnv === 'production', path: '/', maxAge: 30 * 86400 });
    return c.json({ ok: true });
  });
  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Gate everything else when APP_PASSWORD is configured. Cron uses its own bearer secret.
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/health' || path.startsWith('/api/auth/') || path.startsWith('/api/cron/')) return next();
    if (config.appPassword && !verifySession(config, getCookie(c, SESSION_COOKIE))) return c.json({ error: 'Authentication required.' }, 401);
    return next();
  });

  registerMetaRoutes(app, deps);
  registerCompanyRoutes(app, deps);
  // BD routes first: static paths like /api/opportunities/export.xlsx must win over /api/opportunities/:id.
  registerBdRoutes(app, deps);
  registerOpportunityRoutes(app, deps);
  registerIntelRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerSearchRoutes(app, deps);

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}
