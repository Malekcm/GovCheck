import { registerResearchRoutes } from './research/routes';
import { registerG2xRoutes } from './team/g2x';
import { registerTeamAuth, registerTeamManagement } from './team/auth';
import { authorize, currentActor, actor } from './team/security';
import { registerAssignmentRoutes } from './team/assignments';
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
import { registerTangoRoutes } from './routes/tango';

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
    return c.json({ error: config.teamAuthEnabled ? 'Request failed. Please retry or contact an administrator.' : errorMessage(err) }, 500);
  });

  app.use('/api/*', async (c, next) => {
    c.header('Referrer-Policy','no-referrer');
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });

  if (config.teamAuthEnabled) {
    const providerUrl = config.teamAuthProvider === 'neon' ? config.neonAuthUrl : config.supabaseUrl;
    if (config.nodeEnv === 'production' && (new URL(config.appBaseUrl).protocol !== 'https:' || !providerUrl?.startsWith('https://'))) throw new Error('Production team authentication requires HTTPS application and authentication URLs.');
    if (config.sessionSecret.length < 32 || (config.teamAuthProvider === 'neon' ? !config.neonAuthUrl : (!config.supabaseUrl || !config.supabasePublishableKey || !config.supabaseServiceKey))) throw new Error('Configure the selected authentication provider and a SESSION_SECRET of at least 32 characters.');
    if (config.teamAuthProvider === 'neon' && config.nodeEnv === 'production') {
      const url = new URL(config.neonAuthUrl!);
      if (!url.hostname.endsWith('.neon.tech') || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/auth')) throw new Error('NEON_AUTH_URL must be the branch managed authentication endpoint.');
    }
  }
  app.use('/api/*', async (c, next) => {
    if (config.teamAuthEnabled && !['GET','HEAD'].includes(c.req.method)) {
      const origin = c.req.header('Origin');
      if (origin && origin !== new URL(config.appBaseUrl).origin) throw new HttpProblem(403, 'Cross-origin request rejected.');
    }
    await next();
  });
  if (config.teamAuthEnabled) registerTeamAuth(app, deps);
  // Legacy endpoints are registered only in deliberate compatibility mode.
  if (!config.teamAuthEnabled) {
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

  }

  // Gate everything else when APP_PASSWORD is configured. Cron uses its own bearer secret.
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/health' || path.startsWith('/api/auth/') || path.startsWith('/api/cron/')) return next();
    if (config.teamAuthEnabled) {
      const user = await currentActor(c, deps);
      if (!user) throw new HttpProblem(401, 'Individual team login required.');
      c.set('actor', user);
      await authorize(c, deps, user);
      await next();
      if (c.res.status < 400 && !['GET','HEAD'].includes(c.req.method)) await deps.db.query('INSERT INTO team_audit(actor_id,method,path) VALUES ($1,$2,$3)', [actor(c)!.user_id,c.req.method,c.req.path]);
      return;
    }
    if (config.appPassword && !verifySession(config, getCookie(c, SESSION_COOKIE))) return c.json({ error: 'Authentication required.' }, 401);
    return next();
  });

  if (config.teamAuthEnabled) {
    registerTeamManagement(app, deps);
    registerAssignmentRoutes(app, deps);
    registerResearchRoutes(app, deps);
    registerG2xRoutes(app, deps);
  }
  registerMetaRoutes(app, deps);
  registerCompanyRoutes(app, deps);
  // BD routes first: static paths like /api/opportunities/export.xlsx must win over /api/opportunities/:id.
  registerBdRoutes(app, deps);
  registerOpportunityRoutes(app, deps);
  registerIntelRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerTangoRoutes(app, deps);

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}
