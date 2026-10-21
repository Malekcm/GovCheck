import type { AppConfig } from '../config';
import { HttpProblem, type AppDeps } from '../app';

export interface NeonCredentials { provider: 'neon'; cookie: string }
export interface NeonUser { id: string; email: string; emailVerified: boolean }

/** Server-only client for the branch's published Better Auth OpenAPI endpoints.
 * Provider cookies are encrypted in team_sessions; browsers receive only GovCheck's opaque cookie.
 */
export class NeonAuth {
  constructor(private config: AppConfig) {}
  async call(path: string, body?: unknown, credentials?: NeonCredentials) {
    const base = this.config.neonAuthUrl;
    if (!base) throw new HttpProblem(503, 'Neon authentication is not configured.');
    let response: Response;
    try {
      response = await fetch(`${base.replace(/\/$/, '')}/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Origin: new URL(this.config.appBaseUrl).origin,
          ...(credentials?.cookie ? { Cookie: credentials.cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HttpProblem(503, 'Neon sign-in is temporarily unavailable. Please retry.'); }
    if (!response.ok) {
      // Never expose upstream response bodies, which can contain credential fragments.
      if (response.status === 429) throw new HttpProblem(429, 'Too many sign-in attempts. Wait before retrying.');
      throw new HttpProblem(response.status >= 500 ? 503 : 401, 'Sign-in or verification was not accepted. Check your details and retry.');
    }
    let data: any;
    try { data = await response.json(); } catch { throw new HttpProblem(503, 'Neon returned an invalid authentication response.'); }
    const cookies = new Map((credentials?.cookie ?? '').split('; ').filter(Boolean).map(pair => {
      const i = pair.indexOf('='); return [pair.slice(0, i), pair.slice(i + 1)];
    }));
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0], i = pair.indexOf('=');
      if (i > 0) {
        const key = pair.slice(0, i);
        if (/max-age=0(?:;|$)/i.test(header)) cookies.delete(key);
        else cookies.set(key, pair.slice(i + 1));
      }
    }
    return { data, credentials: { provider: 'neon' as const, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } };
  }
  async verify(credentials: NeonCredentials) {
    if (!credentials.cookie) return null;
    try {
      const result = await this.call('get-session?disableCookieCache=true', undefined, credentials);
      const user = result.data?.user as NeonUser | undefined;
      if (!result.data?.session || !user?.id || !user.emailVerified || !user.email) return null;
      return { user, credentials: result.credentials };
    } catch (error) {
      if (error instanceof HttpProblem && error.status === 401) return null;
      throw error;
    }
  }
  async sendCode(email: string) { await this.call('email-otp/send-verification-otp', { email, type: 'sign-in' }); }
}

/** Shared across instances. An email cannot be spammed or brute-forced by changing IP headers. */
export async function authRateLimit(deps: AppDeps, scope: string, email: string, limit: number) {
  const { digest } = await import('./security');
  const key = digest(`${scope}:${email.toLowerCase()}`);
  const row = await deps.db.one(`INSERT INTO auth_rate_limits(key,count,reset_at) VALUES ($1,1,now()+interval '10 minutes')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.reset_at<=now() THEN 1 ELSE auth_rate_limits.count+1 END,
    reset_at=CASE WHEN auth_rate_limits.reset_at<=now() THEN now()+interval '10 minutes' ELSE auth_rate_limits.reset_at END RETURNING count`, [key]);
  if (row!.count > limit) throw new HttpProblem(429, 'Too many attempts. Wait ten minutes before retrying.');
}
