import crypto from 'node:crypto';
import type { Context } from 'hono';
import { createClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config';
import type { AppDeps } from '../app';
import { HttpProblem } from '../app';
import { getCookie } from 'hono/cookie';
import { NeonAuth } from './neon';
import { emailAllowed } from './emailPolicy';

export type Role = 'admin' | 'manager' | 'member' | 'viewer';
export interface Actor { user_id: string; organization_id: string; email: string; name: string; role: Role; active: boolean }
export function actor(c: Context): Actor | undefined { return c.get('actor'); }
export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function seal(secret: string, value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
export function unseal<T = any>(secret: string, value: string): T {
  const data = Buffer.from(value, 'base64url');
  const cipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
}
export function authClient(config: AppConfig, admin = false) {
  const key = admin ? config.supabaseServiceKey : config.supabasePublishableKey;
  if (!config.supabaseUrl || !key) throw new HttpProblem(503, 'Supabase authentication is not configured.');
  return createClient(config.supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
export async function currentActor(c: Context, deps: AppDeps): Promise<Actor | undefined> {
  const token = getCookie(c, 'govcheck_team');
  if (!token) return;
  // Row lock serializes refresh-token rotation across simultaneous requests.
  return deps.db.tx(async tx => {
    const row = await tx.one('SELECT * FROM team_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE', [digest(token)]);
    if (!row) return;
    const member = await tx.one<Actor>('SELECT * FROM team_members WHERE user_id=$1 AND active', [row.user_id]);
    if (!member || !emailAllowed(deps.config,member.email)) return;
    let credentials:any;
    try { credentials=unseal(deps.config.sessionSecret,row.credentials); } catch { return; }
    if (deps.config.teamAuthProvider === 'neon') {
      if (credentials.provider !== 'neon') return;
      const verified = await new NeonAuth(deps.config).verify(credentials);
      if (!verified) return;
      const identity = await tx.one('SELECT auth_provider,auth_subject FROM team_members WHERE user_id=$1', [member.user_id]);
      if (identity?.auth_provider !== 'neon' || identity.auth_subject !== verified.user.id || verified.user.email.toLowerCase() !== member.email.toLowerCase()) return;
      if (verified.credentials.cookie !== credentials.cookie) await tx.query('UPDATE team_sessions SET credentials=$2 WHERE id=$1', [row.id, seal(deps.config.sessionSecret, verified.credentials)]);
      return member;
    }
    const client = authClient(deps.config);
    if (credentials.expires_at * 1000 < Date.now() + 60_000) {
      const refreshed = await client.auth.refreshSession({ refresh_token: credentials.refresh_token });
      if (refreshed.error || !refreshed.data.session) return;
      credentials = refreshed.data.session;
      await tx.query('UPDATE team_sessions SET credentials=$2 WHERE id=$1', [row.id, seal(deps.config.sessionSecret, credentials)]);
    }
    const verified = await client.auth.getUser(credentials.access_token);
    if (verified.error || verified.data.user?.id !== member.user_id || !emailAllowed(deps.config,verified.data.user?.email)) return;
    return member;
  });
}

/** All current team members can read the shared procurement dossier. Writes fail closed. */
export async function authorize(c: Context, deps: AppDeps, user: Actor) {
  const path = c.req.path;
  const read = ['GET', 'HEAD'].includes(c.req.method);
  if (/^\/api\/(team\/admin|export\/backup)/.test(path) && user.role !== 'admin') throw new HttpProblem(403, 'Administrator access required.');
  if (read) return;
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(deps.config.appBaseUrl).origin) throw new HttpProblem(403, 'Cross-origin request rejected.');
  if (/^\/api\/team\/notifications\/[^/]+\/read$/.test(path)) return;
  if (path === '/api/session/visit' || /\/view$/.test(path) || path.startsWith('/api/g2x/')) return;
  if (user.role === 'admin') return;
  if (/^\/api\/(sources|sync|company|capabilities|tango\/(test|clear-auth-block)|export)/.test(path)) throw new HttpProblem(403, 'Administrator access required.');
  if (user.role === 'viewer') throw new HttpProblem(403, 'View-only account.');
  if (user.role === 'manager') return;
  if (/^\/api\/opportunities\/[0-9a-f-]{36}\/claim$/i.test(path) && c.req.method === 'POST') return;
  const match = path.match(/^\/api\/opportunities\/([0-9a-f-]{36})\/(capture|decision|notes|tags|assignment-progress\/[^/]+|research(?:\/.*)?)$/i);
  let id = match?.[1];
  if (/^\/api\/notes\//.test(path)) id = (await deps.db.one('SELECT opportunity_id FROM user_notes WHERE id::text=$1', [path.split('/').at(-1)]))?.opportunity_id;
  if (!id || !await deps.db.one('SELECT 1 FROM opportunity_assignments WHERE opportunity_id=$1 AND user_id=$2 AND active', [id, user.user_id])) throw new HttpProblem(403, 'This action requires an assigned opportunity or a manager.');
}

declare module 'hono' { interface ContextVariableMap { actor: Actor | undefined } }
