import crypto from 'node:crypto';
import type { Hono, Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { actor, authClient, currentActor, digest, seal, unseal } from './security';

export async function createTeamSession(c: Context, deps: AppDeps, session: any) {
  const verified = await authClient(deps.config).auth.getUser(session.access_token);
  if (verified.error || !verified.data.user) throw new HttpProblem(401, 'Invalid session.');
  const user = verified.data.user;
  if (!await deps.db.one('SELECT 1 FROM team_members WHERE user_id=$1 AND active', [user.id])) throw new HttpProblem(403, 'This account has no active team membership.');
  await deps.db.query('DELETE FROM team_sessions WHERE expires_at<now()');
  const token = crypto.randomBytes(32).toString('base64url');
  await deps.db.query('INSERT INTO team_sessions(id,user_id,credentials,expires_at) VALUES ($1,$2,$3,now()+interval \'7 days\')', [digest(token), user.id, seal(deps.config.sessionSecret, session)]);
  setCookie(c, 'govcheck_team', token, { httpOnly: true, secure: deps.config.nodeEnv === 'production', sameSite: 'Lax', path: '/', maxAge: 7 * 86400 });
}
export function registerTeamAuth(app: Hono, deps: AppDeps) {
  app.get('/api/auth/me', async c => {
    const user = await currentActor(c, deps);
    return c.json({ authRequired: true, authenticated: !!user, teamAuth: true, user });
  });
  app.post('/api/auth/login', async c => {
    const b = z.object({ email: z.email(), password: z.string().min(1).max(1000) }).parse(await readJson(c));
    const res = await authClient(deps.config).auth.signInWithPassword(b);
    if (res.error || !res.data.session) throw new HttpProblem(401, 'Email or password was not accepted.');
    await createTeamSession(c, deps, res.data.session);
    return c.json({ ok: true });
  });
  // Default Supabase invitation/recovery links return a fragment. The client exchanges it once,
  // immediately clears the URL and never stores tokens in browser storage.
  app.post('/api/auth/accept', async c => {
    const b = z.object({ access_token: z.string().min(1).max(10000), refresh_token: z.string().min(1).max(10000) }).parse(await readJson(c));
    const res = await authClient(deps.config).auth.setSession(b);
    if (res.error || !res.data.session) throw new HttpProblem(401, 'Invitation or recovery link expired.');
    await createTeamSession(c, deps, res.data.session);
    return c.json({ ok: true });
  });
  app.post('/api/auth/reset', async c => {
    const b = z.object({ email: z.email() }).parse(await readJson(c));
    await authClient(deps.config).auth.resetPasswordForEmail(b.email, { redirectTo: `${deps.config.appBaseUrl}/auth/accept` });
    return c.json({ ok: true, message: 'If the account exists, a recovery email will arrive.' });
  });
  app.post('/api/auth/password', async c => {
    const user = await currentActor(c, deps);
    if (!user) throw new HttpProblem(401, 'Sign in through your invitation or recovery link first.');
    const b = z.object({ password: z.string().min(12).max(200) }).parse(await readJson(c));
    const row = await deps.db.one('SELECT credentials FROM team_sessions WHERE id=$1', [digest(getCookie(c, 'govcheck_team') ?? '')]);
    const session = unseal(deps.config.sessionSecret, row.credentials);
    const client = authClient(deps.config);
    await client.auth.setSession(session);
    const result = await client.auth.updateUser({ password: b.password });
    if (result.error) throw new HttpProblem(400, 'Password update failed. Check the password policy and retry.');
    return c.json({ ok: true });
  });
  app.post('/api/auth/logout', async c => {
    const id = digest(getCookie(c, 'govcheck_team') ?? '');
    const row = await deps.db.one('DELETE FROM team_sessions WHERE id=$1 RETURNING credentials', [id]);
    deleteCookie(c, 'govcheck_team', { path: '/' });
    if (row) await authClient(deps.config, true).auth.admin.signOut(unseal(deps.config.sessionSecret, row.credentials).access_token, 'local');
    return c.json({ ok: true });
  });
}

/** Explicit local CLI only; never runs automatically or grants privilege at login. */
export async function bootstrapAdmin(deps: AppDeps) {
  const email = z.email().parse(deps.config.bootstrapAdminEmail).toLowerCase();
  await deps.db.tx(async tx=>{
    await tx.query('SELECT id FROM organizations ORDER BY id LIMIT 1 FOR UPDATE');
    if (await tx.one("SELECT 1 FROM team_members WHERE role='admin'")) throw new Error('An administrator already exists. Bootstrap is one-time only.');
    const res = await authClient(deps.config, true).auth.admin.inviteUserByEmail(email, { redirectTo: `${deps.config.appBaseUrl}/auth/accept` });
    if (res.error || !res.data.user) throw new Error('Supabase admin invitation failed. Check configuration and account state.');
    await tx.query("INSERT INTO team_members(user_id,organization_id,email,name,role) SELECT $1,id,$2,$2,'admin' FROM organizations ORDER BY id LIMIT 1", [res.data.user.id, email]);
  });
}
export function registerTeamManagement(app: Hono, deps: AppDeps) {
  app.get('/api/team/members', async c => c.json(await deps.db.query('SELECT user_id,email,name,role,active FROM team_members WHERE organization_id=$1 ORDER BY name', [actor(c)!.organization_id])));
  app.post('/api/team/admin/invite', async c => {
    const b = z.object({ email: z.email(), name: z.string().trim().min(1).max(150), role: z.enum(['admin','manager','member','viewer']) }).strict().parse(await readJson(c));
    if (await deps.db.one('SELECT 1 FROM team_members WHERE lower(email)=lower($1)', [b.email])) throw new HttpProblem(409, 'This account already belongs to the team.');
    const res = await authClient(deps.config, true).auth.admin.inviteUserByEmail(b.email, { redirectTo: `${deps.config.appBaseUrl}/auth/accept` });
    if (res.error || !res.data.user) throw new HttpProblem(400, 'Invitation could not be sent. Verify Supabase email delivery and account state.');
    await deps.db.query('INSERT INTO team_members(user_id,organization_id,email,name,role) VALUES ($1,$2,$3,$4,$5)', [res.data.user.id, actor(c)!.organization_id, b.email.toLowerCase(), b.name, b.role]);
    return c.json({ ok: true }, 201);
  });
  app.put('/api/team/admin/members/:id', async c => {
    const b = z.object({ role: z.enum(['admin','manager','member','viewer']), active: z.boolean(), name: z.string().trim().min(1).max(150) }).strict().parse(await readJson(c));
    const id = z.uuid().parse(c.req.param('id'));
    await deps.db.tx(async tx => {
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [actor(c)!.organization_id]);
      const old = await tx.one('SELECT * FROM team_members WHERE user_id=$1 AND organization_id=$2', [id, actor(c)!.organization_id]);
      if (!old) throw new HttpProblem(404, 'Member not found.');
      if (old.role === 'admin' && old.active && (b.role !== 'admin' || !b.active) && !await tx.one("SELECT 1 FROM team_members WHERE organization_id=$1 AND user_id<>$2 AND role='admin' AND active", [old.organization_id, id])) throw new HttpProblem(409, 'Keep at least one active administrator.');
      await tx.query('UPDATE team_members SET role=$2,active=$3,name=$4 WHERE user_id=$1', [id, b.role, b.active, b.name]);
      if (!b.active) await tx.query('DELETE FROM team_sessions WHERE user_id=$1', [id]);
    });
    return c.json({ ok: true });
  });
}
