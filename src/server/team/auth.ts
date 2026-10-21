import crypto from 'node:crypto';
import type { Hono, Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { actor, authClient, currentActor, digest, seal, unseal } from './security';
import { authRateLimit, NeonAuth } from './neon';
import { emailAllowed, requireAllowedEmail } from './emailPolicy';

export async function createTeamSession(c: Context, deps: AppDeps, session: any) {
  let userId: string;
  if (deps.config.teamAuthProvider === 'neon') {
    const verified = await new NeonAuth(deps.config).verify(session);
    if (!verified) throw new HttpProblem(401, 'Verify your email before signing in.');
    requireAllowedEmail(deps.config,verified.user.email);
    userId = await deps.db.tx(async tx => {
      const member = await tx.one("SELECT * FROM team_members WHERE lower(email)=lower($1) AND active AND auth_provider='neon' FOR UPDATE", [verified.user.email]);
      if (!member || (member.auth_subject && member.auth_subject !== verified.user.id)) throw new HttpProblem(403, 'This account has no active team invitation.');
      await tx.query('UPDATE team_members SET auth_subject=$2 WHERE user_id=$1', [member.user_id, verified.user.id]);
      return member.user_id;
    });
    session = verified.credentials;
  } else {
  const verified = await authClient(deps.config).auth.getUser(session.access_token);
  if (verified.error || !verified.data.user) throw new HttpProblem(401, 'Invalid session.');
  const user = verified.data.user;
  requireAllowedEmail(deps.config,user.email);
  if (!await deps.db.one('SELECT 1 FROM team_members WHERE user_id=$1 AND active', [user.id])) throw new HttpProblem(403, 'This account has no active team membership.');
  userId = user.id;
  }
  await deps.db.query('DELETE FROM team_sessions WHERE expires_at<now()');
  const token = crypto.randomBytes(32).toString('base64url');
  await deps.db.query('INSERT INTO team_sessions(id,user_id,credentials,expires_at) VALUES ($1,$2,$3,now()+interval \'7 days\')', [digest(token), userId, seal(deps.config.sessionSecret, session)]);
  setCookie(c, 'govcheck_team', token, { httpOnly: true, secure: deps.config.nodeEnv === 'production', sameSite: 'Lax', path: '/', maxAge: 7 * 86400 });
}
export function registerTeamAuth(app: Hono, deps: AppDeps) {
  app.get('/api/auth/me', async c => {
    const user = await currentActor(c, deps);
    return c.json({ authRequired: true, authenticated: !!user, teamAuth: true, authProvider: deps.config.teamAuthProvider, allowedEmailDomains:deps.config.allowedEmailDomains, user });
  });
  if (deps.config.teamAuthProvider === 'neon') {
    registerNeonAuth(app, deps);
    return;
  }
  app.post('/api/auth/login', async c => {
    const b = z.object({ email: z.email(), password: z.string().min(1).max(1000) }).parse(await readJson(c));
    requireAllowedEmail(deps.config,b.email);
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
    requireAllowedEmail(deps.config,b.email);
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
  requireAllowedEmail(deps.config,email);
  if (deps.config.teamAuthProvider === 'neon') {
    await deps.db.tx(async tx => {
      await tx.query('SELECT id FROM organizations ORDER BY id LIMIT 1 FOR UPDATE');
      const admin = await tx.one("SELECT * FROM team_members WHERE role='admin' LIMIT 1");
      if (admin) {
        if (admin.email.toLowerCase() === email && admin.active && admin.auth_provider === 'neon' && !admin.auth_subject) return;
        throw new Error('An administrator already exists. Bootstrap is one-time only.');
      }
      await tx.query("INSERT INTO team_members(user_id,organization_id,email,name,role,auth_provider) SELECT gen_random_uuid(),id,$1,$1,'admin','neon' FROM organizations ORDER BY id LIMIT 1", [email]);
    });
    await new NeonAuth(deps.config).sendCode(email);
    return;
  }
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
    requireAllowedEmail(deps.config,b.email);
    if (deps.config.teamAuthProvider === 'neon') {
      await deps.db.tx(async tx => {
        await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [actor(c)!.organization_id]);
        if (await tx.one('SELECT 1 FROM team_members WHERE lower(email)=lower($1)', [b.email])) throw new HttpProblem(409, 'This account already belongs to the team. Use resend sign-in code.');
        await tx.query("INSERT INTO team_members(user_id,organization_id,email,name,role,auth_provider) VALUES (gen_random_uuid(),$1,$2,$3,$4,'neon')", [actor(c)!.organization_id,b.email.toLowerCase(),b.name,b.role]);
      });
      try { await new NeonAuth(deps.config).sendCode(b.email.toLowerCase()); }
      catch { return c.json({ ok:true, message:'Team access added. Email delivery failed; your colleague can request a new sign-in code on the login page.' },201); }
      return c.json({ ok:true, message:'Team access added. Your colleague can sign in with the code emailed by GovCheck.' },201);
    }
    if (await deps.db.one('SELECT 1 FROM team_members WHERE lower(email)=lower($1)', [b.email])) throw new HttpProblem(409, 'This account already belongs to the team.');
    const res = await authClient(deps.config, true).auth.admin.inviteUserByEmail(b.email, { redirectTo: `${deps.config.appBaseUrl}/auth/accept` });
    if (res.error || !res.data.user) throw new HttpProblem(400, 'Invitation could not be sent. Verify Supabase email delivery and account state.');
    await deps.db.query('INSERT INTO team_members(user_id,organization_id,email,name,role) VALUES ($1,$2,$3,$4,$5)', [res.data.user.id, actor(c)!.organization_id, b.email.toLowerCase(), b.name, b.role]);
    return c.json({ ok: true }, 201);
  });
  app.post('/api/team/admin/members/:id/resend', async c => {
    if (deps.config.teamAuthProvider !== 'neon') throw new HttpProblem(400,'Available for Neon accounts only.');
    const member = await deps.db.one("SELECT email FROM team_members WHERE user_id=$1 AND organization_id=$2 AND active AND auth_provider='neon'", [z.uuid().parse(c.req.param('id')),actor(c)!.organization_id]);
    if (!member) throw new HttpProblem(404,'Active member not found.');
    requireAllowedEmail(deps.config,member.email);
    await authRateLimit(deps,'code',member.email,5);
    await new NeonAuth(deps.config).sendCode(member.email);
    return c.json({ok:true});
  });
  app.put('/api/team/admin/members/:id', async c => {
    const b = z.object({ role: z.enum(['admin','manager','member','viewer']), active: z.boolean(), name: z.string().trim().min(1).max(150) }).strict().parse(await readJson(c));
    const id = z.uuid().parse(c.req.param('id'));
    await deps.db.tx(async tx => {
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [actor(c)!.organization_id]);
      const old = await tx.one('SELECT * FROM team_members WHERE user_id=$1 AND organization_id=$2', [id, actor(c)!.organization_id]);
      if (!old) throw new HttpProblem(404, 'Member not found.');
      if (b.active) requireAllowedEmail(deps.config,old.email);
      if (old.role === 'admin' && old.active && (b.role !== 'admin' || !b.active) && !await tx.one("SELECT 1 FROM team_members WHERE organization_id=$1 AND user_id<>$2 AND role='admin' AND active", [old.organization_id, id])) throw new HttpProblem(409, 'Keep at least one active administrator.');
      await tx.query('UPDATE team_members SET role=$2,active=$3,name=$4 WHERE user_id=$1', [id, b.role, b.active, b.name]);
      if (!b.active) await tx.query('DELETE FROM team_sessions WHERE user_id=$1', [id]);
    });
    return c.json({ ok: true });
  });
}

function registerNeonAuth(app: Hono, deps: AppDeps) {
  const client = new NeonAuth(deps.config);
  const invited = async (email:string) => emailAllowed(deps.config,email) && !!await deps.db.one("SELECT 1 FROM team_members WHERE lower(email)=lower($1) AND active AND auth_provider='neon'", [email]);
  app.post('/api/auth/code', async c => {
    const {email} = z.object({email:z.email()}).parse(await readJson(c));
    requireAllowedEmail(deps.config,email);
    await authRateLimit(deps,'code',email,5);
    await authRateLimit(deps,'mail-global','all',200);
    if (await invited(email)) await client.sendCode(email.toLowerCase());
    return c.json({ok:true,message:'If you have team access, a sign-in code will arrive by email.'});
  });
  app.post('/api/auth/login', async c => {
    const b = z.object({email:z.email(), password:z.string().min(1).max(1000).optional(), otp:z.string().regex(/^\d{6,8}$/).optional()})
      .refine(b=>!!b.password !== !!b.otp,'Provide a password or a code.').parse(await readJson(c));
    requireAllowedEmail(deps.config,b.email);
    await authRateLimit(deps,'login',b.email,20);
    if (!await invited(b.email)) throw new HttpProblem(401,'Sign-in was not accepted. Ask your administrator for team access.');
    const result = b.otp ? await client.call('sign-in/email-otp',{email:b.email.toLowerCase(),otp:b.otp}) : await client.call('sign-in/email',{email:b.email.toLowerCase(),password:b.password});
    await createTeamSession(c,deps,result.credentials);
    return c.json({ok:true});
  });
  app.post('/api/auth/reset', async c => {
    const {email} = z.object({email:z.email()}).parse(await readJson(c));
    requireAllowedEmail(deps.config,email);
    await authRateLimit(deps,'reset',email,5);
    await authRateLimit(deps,'mail-global','all',200);
    if (await invited(email)) await client.call('email-otp/request-password-reset',{email:email.toLowerCase()});
    return c.json({ok:true,message:'If your account exists, a password reset code will arrive by email.'});
  });
  app.post('/api/auth/password', async c => {
    const b = z.object({email:z.email(),otp:z.string().regex(/^\d{6,8}$/),password:z.string().min(12).max(200)}).parse(await readJson(c));
    requireAllowedEmail(deps.config,b.email);
    await authRateLimit(deps,'reset-verify',b.email,10);
    if (!await invited(b.email)) throw new HttpProblem(401,'Password reset was not accepted.');
    await client.call('email-otp/reset-password',{...b,email:b.email.toLowerCase()});
    // Invalidate all local sessions; provider reset also controls its session policy.
    await deps.db.query('DELETE FROM team_sessions WHERE user_id IN (SELECT user_id FROM team_members WHERE lower(email)=lower($1))',[b.email]);
    const result = await client.call('sign-in/email',{email:b.email.toLowerCase(),password:b.password});
    await createTeamSession(c,deps,result.credentials);
    return c.json({ok:true});
  });
  app.post('/api/auth/logout', async c => {
    const row = await deps.db.one('DELETE FROM team_sessions WHERE id=$1 RETURNING credentials',[digest(getCookie(c,'govcheck_team')??'')]);
    deleteCookie(c,'govcheck_team',{path:'/'});
    if(row) {
      try { await client.call('sign-out',{},unseal(deps.config.sessionSecret,row.credentials)); }
      catch { /* Local revocation is authoritative even if the provider is unavailable. */ }
    }
    return c.json({ok:true});
  });
}
