import crypto from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createApp,issueSession} from '../src/server/app';
import {bootstrapAdmin} from '../src/server/team/auth';
import {seal,unseal} from '../src/server/team/security';
import {createTestDb,testDeps} from './helpers/setup';
import type {Db} from '../src/server/db';

const open:Db[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(open.splice(0).map(db=>db.close()));});
async function setup() {
  const db=await createTestDb();open.push(db);
  const deps=await testDeps(db,undefined,{teamAuthEnabled:true,teamAuthProvider:'neon',neonAuthUrl:'https://branch.neon.tech/neondb/auth',appBaseUrl:'https://govcheck.example',sessionSecret:'neon-test-session-secret-with-at-least-32-characters',bootstrapAdminEmail:'admin@example.test'});
  const users=new Map<string,any>(),sessions=new Map<string,any>(),sent:string[]=[];
  let rotate=false,invalidJson=false,unverified=false;
  const provider=vi.fn(async(input:any,init:any={})=>{
    const url=new URL(String(input)),endpoint=url.pathname.replace('/neondb/auth/',''),b=init.body?JSON.parse(init.body):{};
    expect(init.headers.Origin).toBe('https://govcheck.example');
    const cookie=init.headers.Cookie;
    const answer=(data:any,status=200,cookieValue?:string)=>new Response(invalidJson?'secret-token malformed payload':JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...(cookieValue?{'Set-Cookie':`neon-auth.session_token=${cookieValue}; HttpOnly; Secure; Path=/`}:{})}});
    if(endpoint==='email-otp/send-verification-otp'){sent.push(b.email);return answer({success:true});}
    if(endpoint==='email-otp/request-password-reset')return answer({success:true});
    if(endpoint==='email-otp/reset-password')return answer(b.otp==='123456'?{success:true}:{},b.otp==='123456'?200:400);
    if(endpoint==='sign-in/email-otp'||endpoint==='sign-in/email') {
      if((b.otp&&b.otp!=='123456')||(b.password&&b.password!=='valid-password'))return answer({},401);
      const user=users.get(b.email)??{id:`neon-${crypto.randomUUID()}`,email:b.email,emailVerified:!unverified};
      users.set(b.email,user);const token=crypto.randomUUID();sessions.set(`neon-auth.session_token=${token}`,user);
      return answer({token,user},200,token);
    }
    if(endpoint==='get-session') {
      expect(url.searchParams.get('disableCookieCache')).toBe('true');
      const user=sessions.get(cookie);if(!user)return answer(null);
      if(rotate){rotate=false;const token=crypto.randomUUID();sessions.delete(cookie);sessions.set(`neon-auth.session_token=${token}`,user);return answer({session:{id:token},user},200,token);}
      return answer({session:{id:'session'},user});
    }
    if(endpoint==='sign-out'){sessions.delete(cookie);return answer({success:true});}
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  vi.stubGlobal('fetch',provider);
  const app=createApp(deps);
  const request=(path:string,body?:any,cookie?:string,method=body===undefined?'GET':'POST')=>app.request(path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const add=async(email:string,role='member')=>(await db.one("INSERT INTO team_members(user_id,organization_id,email,name,role,auth_provider) SELECT gen_random_uuid(),id,$1,$1,$2,'neon' FROM organizations LIMIT 1 RETURNING user_id",[email,role]))!.user_id;
  const login=async(email:string)=>{const res=await request('/api/auth/login',{email,otp:'123456'});expect(res.status).toBe(200);return res.headers.get('set-cookie')!.split(';')[0];};
  return {db,deps,users,sessions,sent,provider,app,request,add,login,rotate:()=>{rotate=true;},badJson:()=>{invalidJson=true;},unverified:()=>{unverified=true;}};
}

describe('Neon Auth with application membership',()=>{
  it('bootstraps an allowlisted administrator once, resumes delivery, and binds a verified Neon subject to a stable UUID',async()=>{
    const {db,deps,sent,login,request,users}=await setup();
    await bootstrapAdmin(deps);await bootstrapAdmin(deps);
    expect(sent).toEqual(['admin@example.test','admin@example.test']);
    expect((await db.one('SELECT count(*)::int AS n FROM team_members'))!.n).toBe(1);
    const before=await db.one('SELECT * FROM team_members');expect(before!.auth_subject).toBeNull();
    const cookie=await login('admin@example.test');
    const me=await (await request('/api/auth/me',undefined,cookie)).json() as any;
    expect(me.user.role).toBe('admin');expect(me.user.user_id).toBe(before!.user_id);expect(me.authProvider).toBe('neon');
    expect((await db.one('SELECT auth_subject FROM team_members'))!.auth_subject).toBe(users.get('admin@example.test').id);
    await expect(bootstrapAdmin(deps)).rejects.toThrow('already exists');
    const session=await db.one('SELECT * FROM team_sessions');expect(session!.credentials).not.toContain('session_token');
    expect(unseal(deps.config.sessionSecret,session!.credentials).provider).toBe('neon');
  });
  it('denies uninvited, unverified, mismatched, inactive and legacy shared sessions',async()=>{
    const s=await setup();
    expect((await s.request('/api/auth/login',{email:'stranger@example.test',otp:'123456'})).status).toBe(401);expect(s.provider).not.toHaveBeenCalled();
    await s.add('member@example.test');s.unverified();
    expect((await s.request('/api/auth/login',{email:'member@example.test',otp:'123456'})).status).toBe(401);
    s.users.get('member@example.test').emailVerified=true;
    const cookie=await s.login('member@example.test');
    expect((await s.request('/api/company',undefined,cookie)).status).toBe(200);
    s.users.get('member@example.test').id='different-subject';
    expect((await s.request('/api/company',undefined,cookie)).status).toBe(401);
    expect((await s.request('/api/auth/login',{email:'member@example.test',otp:'123456'})).status).toBe(403);
    await s.db.query('UPDATE team_members SET active=false');
    expect((await s.request('/api/company',undefined,cookie)).status).toBe(401);
    expect((await s.request('/api/company',undefined,`goi_session=${issueSession(s.deps.config)}`)).status).toBe(401);
  });
  it('handles provider cookie rotation, enforces revocation, and removes sessions at logout',async()=>{
    const s=await setup();await s.add('member@example.test');const cookie=await s.login('member@example.test');
    s.rotate();expect((await s.request('/api/company',undefined,cookie)).status).toBe(200);
    expect((await s.request('/api/company',undefined,cookie)).status).toBe(200);
    expect((await s.request('/api/auth/logout',{},cookie)).status).toBe(200);
    expect((await s.request('/api/company',undefined,cookie)).status).toBe(401);expect(s.sessions.size).toBe(0);
  });
  it('rate-limits mail and code guessing and never sends mail for unknown accounts',async()=>{
    const s=await setup();await s.add('member@example.test');
    expect((await s.request('/api/auth/code',{email:'unknown@example.test'})).status).toBe(200);expect(s.sent).toEqual([]);
    for(let i=0;i<5;i++)expect((await s.request('/api/auth/code',{email:'member@example.test'})).status).toBe(200);
    expect((await s.request('/api/auth/code',{email:'MEMBER@example.test'})).status).toBe(429);expect(s.sent).toHaveLength(5);
    for(let i=0;i<20;i++)expect((await s.request('/api/auth/login',{email:'member@example.test',otp:'999999'})).status).toBe(401);
    expect((await s.request('/api/auth/login',{email:'member@example.test',otp:'123456'})).status).toBe(429);
  });
  it('accepts only reset codes verified by Neon and clears prior sessions before password sign-in',async()=>{
    const s=await setup();await s.add('member@example.test');const old=await s.login('member@example.test');
    expect((await s.request('/api/auth/reset',{email:'member@example.test'})).status).toBe(200);
    expect((await s.request('/api/auth/password',{email:'member@example.test',otp:'999999',password:'valid-password'})).status).toBe(401);
    const res=await s.request('/api/auth/password',{email:'member@example.test',otp:'123456',password:'valid-password'});
    expect(res.status).toBe(200);expect((await s.request('/api/company',undefined,old)).status).toBe(401);
    expect((await s.request('/api/company',undefined,res.headers.get('set-cookie')!.split(';')[0])).status).toBe(200);
  });
  it('limits invitations to administrators, supports resend and blocks deactivated accounts immediately',async()=>{
    const s=await setup();await s.add('admin@example.test','admin');await s.add('member@example.test');
    const admin=await s.login('admin@example.test'),member=await s.login('member@example.test');
    const body={email:'new@example.test',name:'New colleague',role:'member'};
    expect((await s.request('/api/team/admin/invite',body,member)).status).toBe(403);
    expect((await s.request('/api/team/admin/invite',body,admin)).status).toBe(201);
    const target=await s.db.one('SELECT * FROM team_members WHERE email=$1',[body.email]);expect(target!.auth_subject).toBeNull();
    expect((await s.request(`/api/team/admin/members/${target!.user_id}/resend`,{},admin)).status).toBe(200);
    expect(s.sent).toEqual([body.email,body.email]);
    const cookie=await s.login(body.email);
    expect((await s.request(`/api/team/admin/members/${target!.user_id}`,{role:'member',active:false,name:body.name},admin,'PUT')).status).toBe(200);
    expect((await s.request('/api/company',undefined,cookie)).status).toBe(401);
  });
  it('allows members to claim unassigned opportunities and tag their own items, with one concurrent winner',async()=>{
    const s=await setup();await s.add('first@example.test');await s.add('second@example.test');await s.add('viewer@example.test','viewer');
    const first=await s.login('first@example.test'),second=await s.login('second@example.test'),viewer=await s.login('viewer@example.test');
    const id=(await s.db.one("INSERT INTO opportunities(title,opportunity_class,stage,status) VALUES ('Claim opportunity','prime','forecast','forecast') RETURNING id"))!.id;
    expect((await s.request(`/api/opportunities/${id}/claim`,{},viewer)).status).toBe(403);
    const replies=await Promise.all([s.request(`/api/opportunities/${id}/claim`,{},first),s.request(`/api/opportunities/${id}/claim`,{},second)]);
    expect(replies.map(r=>r.status).sort()).toEqual([200,409]);
    const winner=replies[0].status===200?first:second,loser=winner===first?second:first;
    expect((await s.request(`/api/opportunities/${id}/claim`,{},winner)).status).toBe(200);
    expect((await s.request(`/api/opportunities/${id}/tags`,{tags:['My capture']},winner,'PUT')).status).toBe(200);
    expect((await s.request(`/api/opportunities/${id}/tags`,{tags:['Override']},loser,'PUT')).status).toBe(403);
    expect((await s.db.one('SELECT count(*)::int AS n FROM assignment_history'))!.n).toBe(1);
    expect((await s.db.one('SELECT tag FROM user_tags WHERE opportunity_id=$1',[id]))!.tag).toBe('My capture');
  });
  it('sanitizes malformed provider responses and rejects credentials from another provider',async()=>{
    const s=await setup();const id=await s.add('member@example.test');
    await s.db.query("INSERT INTO team_sessions(id,user_id,credentials,expires_at) VALUES ('legacy',$1,$2,now()+interval '1 day')",[id,seal(s.deps.config.sessionSecret,{access_token:'not-neon'})]);
    s.badJson();const response=await s.request('/api/auth/login',{email:'member@example.test',otp:'123456'});
    expect(response.status).toBe(503);expect(await response.text()).not.toContain('secret-token');
  });
});
