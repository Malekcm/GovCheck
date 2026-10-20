import crypto from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { createApp,issueSession } from '../src/server/app';
import { createTestDb,testDeps,fixtureJson,ingestWith,samRecord } from './helpers/setup';
import { samOpportunitiesAdapter } from '../src/server/connectors/sam/samOpportunities';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootstrapAdmin } from '../src/server/team/auth';
import { runMigrations } from '../src/server/db/migrate';
import type { Db } from '../src/server/db';
import { seal,unseal } from '../src/server/team/security';
import { mergeOpportunities,undoMerge } from '../src/server/pipeline/merge';
import { evidenceSnapshot,loadWorkflow,processResearchJob,validateReport,RESEARCH_SECTIONS } from '../src/server/research/workflow';

const provider=vi.hoisted(()=>({users:new Map<string,any>(),invites:[] as string[]}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({auth:{
  getUser:async(token:string)=>({data:{user:[...provider.users.values()].find(u=>u.id===token)??null},error:null}),
  signInWithPassword:async({email,password}:any)=>{const user=provider.users.get(email);return {data:{session:user&&password==='valid'?{access_token:user.id,refresh_token:'refresh',expires_at:Date.now()/1000+3600}:null},error:null};},
  setSession:async(session:any)=>({data:{session},error:null}),updateUser:async()=>({error:null}),
  resetPasswordForEmail:async()=>({error:null}),refreshSession:async()=>({data:{session:null},error:true}),
  admin:{inviteUserByEmail:async(email:string)=>{provider.invites.push(email);return {data:{user:{id:'99999999-9999-4999-8999-999999999999'}},error:null};},signOut:async()=>({error:null})},
}})}));
const open:Db[]=[];
afterEach(async()=>{await Promise.all(open.splice(0).map(db=>db.close()));provider.users.clear();provider.invites.length=0;});
async function setup() {
  const db=await createTestDb();open.push(db);
  const deps=await testDeps(db,undefined,{teamAuthEnabled:true,supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'publishable',supabaseServiceKey:'server-secret',sessionSecret:'a-very-long-session-secret-at-least-32-characters',researchEnabled:true,anthropicApiKey:'test-key',researchEstimatedCostUsd:2});
  const ids:Record<string,string>={};
  for(const role of ['admin','manager','member','viewer']) {
    const id=crypto.randomUUID();ids[role]=id;provider.users.set(`${role}@test.gov`,{id,email:`${role}@test.gov`});
    await db.query('INSERT INTO team_members(user_id,organization_id,email,name,role) SELECT $1,id,$2,$3,$3 FROM organizations LIMIT 1',[id,`${role}@test.gov`,role]);
  }
  const app=createApp(deps);
  const cookies:Record<string,string>={};
  for(const role of Object.keys(ids)) {
    const res=await app.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:`${role}@test.gov`,password:'valid'})});
    expect(res.status).toBe(200);cookies[role]=res.headers.get('set-cookie')!.split(';')[0];
  }
  const opp=(await db.one("INSERT INTO opportunities(title,opportunity_class,stage,status) VALUES ('Team opportunity','prime','forecast','forecast') RETURNING id"))!.id;
  const request=(role:string,path:string,method='GET',body?:any)=>app.request(path,{method,headers:{Cookie:cookies[role],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const assign=(rows:any[],revision=0,requestId=crypto.randomUUID())=>request('manager',`/api/opportunities/${opp}/assignments`,'PUT',{revision,requestId,assignments:rows});
  const row=(role:string,assignmentRole='owner')=>({userId:ids[role],role:assignmentRole,status:'Not Started',nextAction:'Validate current solicitation',dueDate:'2020-01-01'});
  return {db,deps,app,ids,cookies,opp,request,assign,row};
}

describe('team authentication and route authorization',()=>{
  it('bootstraps only the explicitly configured first administrator, once under concurrent calls',async()=>{
    const db=await createTestDb();open.push(db);
    const deps=await testDeps(db,undefined,{supabaseUrl:'https://example.supabase.co',supabaseServiceKey:'server-only',bootstrapAdminEmail:'first-admin@example.test'});
    const outcomes=await Promise.allSettled([bootstrapAdmin(deps),bootstrapAdmin(deps)]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(provider.invites).toEqual(['first-admin@example.test']);
    const member=await db.one('SELECT * FROM team_members');expect(member.email).toBe('first-admin@example.test');expect(member.role).toBe('admin');
  });
  it('rejects shared-password sessions in team mode, forged identity and inactive members; logout revokes the session',async()=>{
    const {app,deps,db,ids,request}=await setup();
    expect((await app.request('/api/company')).status).toBe(401);
    expect((await app.request('/api/company',{headers:{Cookie:`goi_session=${issueSession(deps.config)}`,'X-User-Id':ids.admin,'X-Role':'admin'}})).status).toBe(401);
    const me=await (await request('member','/api/auth/me')).json() as any;expect(me.user.role).toBe('member');
    expect((await request('viewer','/api/company','PUT',{})).status).toBe(403);
    expect((await request('manager','/api/team/admin/invite','POST',{email:'new@test.gov',name:'New',role:'admin'})).status).toBe(403);
    await db.query('UPDATE team_members SET active=false WHERE user_id=$1',[ids.member]);
    expect((await request('member','/api/company')).status).toBe(401);
    expect((await request('viewer','/api/auth/logout','POST')).status).toBe(200);
    expect((await request('viewer','/api/company')).status).toBe(401);
  });
  it('invites only as admin, retains the last administrator and blocks cross-origin requests',async()=>{
    const {request,ids,app,cookies}=await setup();
    expect((await request('admin','/api/team/admin/invite','POST',{email:'new@test.gov',name:'New',role:'member'})).status).toBe(201);
    expect(provider.invites).toEqual(['new@test.gov']);
    expect((await request('admin',`/api/team/admin/members/${ids.admin}`,'PUT',{role:'member',active:false,name:'Old admin'})).status).toBe(409);
    expect((await app.request('/api/auth/logout',{method:'POST',headers:{Origin:'https://attacker.example',Cookie:cookies.admin}})).status).toBe(403);
    expect((await request('viewer','/api/export/backup.json')).status).toBe(403);
  });
  it('encrypts credentials with authentication and fails on tampering',()=>{
    const encrypted=seal('test-secret',{access_token:'hidden'});expect(encrypted).not.toContain('hidden');expect(unseal('test-secret',encrypted)).toEqual({access_token:'hidden'});expect(()=>unseal('other-secret',encrypted)).toThrow();
  });
});
describe('additive upgrade from the Tango branch',()=>{
  it('retains legacy capture owners, notes and decisions with unknown historical actors',async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'govcheck-upgrade-'));
    try {
      for(const f of fs.readdirSync('migrations').filter(f=>/^00[1-5]_/.test(f)))fs.copyFileSync(path.join('migrations',f),path.join(dir,f));
      const deps=await testDeps({} as Db);const db=await createTestDb({...deps.config,migrationsDir:dir});open.push(db);
      const opp=(await db.one("INSERT INTO opportunities(title,opportunity_class,stage,status) VALUES ('Legacy data','prime','forecast','forecast') RETURNING id"))!.id;
      await db.query("INSERT INTO opportunity_capture(opportunity_id,owner,capture_notes) VALUES ($1,'Unmapped historical owner','Preserve capture notes')",[opp]);
      await db.query("INSERT INTO user_notes(opportunity_id,body) VALUES ($1,'Preserve historical note')",[opp]);
      await db.query("INSERT INTO user_opportunity_decisions(opportunity_id,decision,explanation) VALUES ($1,'watch','Preserve decision')",[opp]);
      await runMigrations(db,path.resolve('migrations'));expect((await runMigrations(db,path.resolve('migrations'))).applied).toHaveLength(0);
      const capture=await db.one('SELECT * FROM opportunity_capture WHERE opportunity_id=$1',[opp]);expect(capture.owner).toBe('Unmapped historical owner');expect(capture.capture_notes).toBe('Preserve capture notes');expect(capture.actor_id).toBeNull();
      expect((await db.one('SELECT body,actor_id FROM user_notes'))!.body).toBe('Preserve historical note');expect((await db.one('SELECT explanation FROM user_opportunity_decisions'))!.explanation).toBe('Preserve decision');
    } finally {for(const f of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,f));fs.rmdirSync(dir);}
  });
});
describe('persistent assignments',()=>{
  it('serializes simultaneous edits and preserves assignment identity when only progress changes',async()=>{
    const {assign,row,request,opp}=await setup();
    const responses=await Promise.all([assign([row('member')]),assign([row('manager')])]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    const before=await (await request('manager',`/api/opportunities/${opp}/assignments`)).json() as any;
    const owner=before.assignments[0];
    const updated={userId:owner.user_id,role:owner.assignment_role,status:'Researching',nextAction:'Follow up',dueDate:null};
    expect((await assign([updated],1)).status).toBe(200);
    const after=await (await request('manager',`/api/opportunities/${opp}/assignments`)).json() as any;
    expect(after.assignments[0].id).toBe(owner.id);expect(after.assignments[0].assigned_at).toBe(owner.assigned_at);expect(after.assignments[0].assigned_by).toBe(owner.assigned_by);
  });
  it('preserves assignments and meaningful research fingerprints through identical and changed source refreshes',async()=>{
    const {db,deps,request,row}=await setup();
    const item=fixtureJson('sam_opportunity_sources_sought.json');
    const first=await ingestWith(db,samOpportunitiesAdapter,[samRecord(item)]);
    const id=first.dirty[0];
    await request('manager',`/api/opportunities/${id}/assignments`,'PUT',{revision:0,requestId:crypto.randomUUID(),assignments:[row('member')]});
    const before=await evidenceSnapshot(deps,id);
    await ingestWith(db,samOpportunitiesAdapter,[samRecord(item)]);
    expect((await evidenceSnapshot(deps,id)).hash).toBe(before.hash);
    await ingestWith(db,samOpportunitiesAdapter,[samRecord({...item,title:'Amended data analytics support'})]);
    const after=await evidenceSnapshot(deps,id);expect(after.hash).not.toBe(before.hash);
    expect((await db.one('SELECT count(*)::int AS count FROM opportunity_assignments WHERE opportunity_id=$1 AND active',[id]))!.count).toBe(1);
    expect((await db.one('SELECT count(*)::int AS count FROM opportunity_sources WHERE opportunity_id=$1',[id]))!.count).toBe(1);
  });
  it('persists after reload, journals attribution, prevents duplicate clicks and lost concurrent writes, and filters by actual user UUID',async()=>{
    const {request,assign,row,opp,ids,db}=await setup();
    const requestId=crypto.randomUUID();
    expect((await assign([row('member'),row('viewer','collaborator')],0,requestId)).status).toBe(200);
    expect((await assign([row('member'),row('viewer','collaborator')],0,requestId)).status).toBe(200);
    const state=await (await request('member',`/api/opportunities/${opp}/assignments`)).json() as any;expect(state.assignments).toHaveLength(2);expect(state.history).toHaveLength(1);expect(state.history[0].actor_name).toBe('manager');
    expect((await assign([row('manager')],0)).status).toBe(409);
    const mine=await (await request('member','/api/opportunities?assignment=mine')).json() as any;expect(mine.items.map((o:any)=>o.id)).toContain(opp);
    const collaborations=await (await request('viewer','/api/opportunities?assignment=collaborations')).json() as any;expect(collaborations.total).toBe(1);
    expect((await (await request('member','/api/opportunities?assignment=unassigned')).json() as any).total).toBe(0);
    expect((await (await request('manager',`/api/opportunities?assignedUser=${ids.viewer}`)).json() as any).total).toBe(1);
    const work=await (await request('member','/api/team/workload?mine=true')).json() as any;expect(work[0].overdue).toBe(true);
    expect((await request('member',`/api/opportunities/${opp}/notes`,'POST',{body:'Attributed note'})).status).toBe(200);
    expect((await db.one('SELECT actor_id FROM user_notes WHERE opportunity_id=$1',[opp]))!.actor_id).toBe(ids.member);
    expect((await assign([],1)).status).toBe(200);
    expect((await request('member',`/api/opportunities/${opp}/notes`,'POST',{body:'No longer assigned'})).status).toBe(403);
  });
  it('permits only self progress, enforces one owner and rejects cross-team/inactive assignees',async()=>{
    const {request,assign,row,opp,db,ids}=await setup();
    expect((await assign([row('member'),row('manager')])).status).toBe(400);
    await assign([row('member')]);
    const state=await (await request('member',`/api/opportunities/${opp}/assignments`)).json() as any;
    const path=`/api/opportunities/${opp}/assignment-progress/${state.assignments[0].id}`;
    expect((await request('member',path,'PUT',{status:'Researching',nextAction:'Research incumbent',dueDate:null})).status).toBe(200);
    expect((await request('viewer',path,'PUT',{status:'Complete',nextAction:null,dueDate:null})).status).toBe(403);
    expect((await request('member',`/api/opportunities/${opp}/assignments`,'PUT',{revision:2,requestId:crypto.randomUUID(),assignments:[]})).status).toBe(403);
    await db.query('UPDATE team_members SET active=false WHERE user_id=$1',[ids.viewer]);
    expect((await assign([row('viewer')],2)).status).toBe(400);
  });
  it('reconciles competing owners, preserves notes, assignment history and research through merge and undo',async()=>{
    const {db,opp,assign,row,ids,request,deps}=await setup();
    await assign([row('member')]);
    const second=(await db.one("INSERT INTO opportunities(title,opportunity_class,stage,status) VALUES ('Duplicate','prime','forecast','forecast') RETURNING id"))!.id;
    await db.query("INSERT INTO opportunity_assignments(opportunity_id,user_id,assignment_role) VALUES ($1,$2,'owner')",[second,ids.manager]);
    await db.query("INSERT INTO user_notes(opportunity_id,body) VALUES ($1,'Preserved legacy note')",[second]);
    const {snapshot,hash}=await evidenceSnapshot(deps,second);
    await db.query("INSERT INTO research_runs(opportunity_id,origin_opportunity_id,initiated_by,skill_version,model,snapshot_hash,snapshot) VALUES ($1,$1,$2,'test','mock',$3,$4::jsonb)",[second,ids.member,hash,JSON.stringify(snapshot)]);
    const merge=await mergeOpportunities(db,opp,second,new Map());
    const merged=await (await request('manager',`/api/opportunities/${opp}/assignments`)).json() as any;expect(merged.assignments).toHaveLength(2);expect(merged.assignments.filter((a:any)=>a.assignment_role==='owner')).toHaveLength(1);
    expect((await db.one('SELECT opportunity_id FROM research_runs'))!.opportunity_id).toBe(opp);
    await undoMerge(db,merge,new Map());
    expect((await db.one('SELECT opportunity_id FROM research_runs'))!.opportunity_id).toBe(second);
    expect((await db.one('SELECT opportunity_id FROM user_notes'))!.opportunity_id).toBe(second);
    expect((await db.one('SELECT assignment_role FROM opportunity_assignments WHERE opportunity_id=$1',[second]))!.assignment_role).toBe('owner');
  });
});
describe('capture research workflow',()=>{
  it('pins the complete skill, queues idempotently, completes once, exposes provenance and downloads editable Word',async()=>{
    const {request,opp,assign,row,deps,db}=await setup();await assign([row('member')]);
    const scope=await (await request('member',`/api/opportunities/${opp}/research/preview`,'POST',{})).json() as any;expect(scope.skillVersion).toContain('1.0.0-');
    const body={hash:scope.hash,skillVersion:scope.skillVersion,model:scope.model,approvedCostUsd:scope.cost.estimate,acknowledgeExternalUsage:true,acknowledgeEstimatedCost:true};
    const first=await (await request('member',`/api/opportunities/${opp}/research/run`,'POST',body)).json() as any;
    const second=await (await request('member',`/api/opportunities/${opp}/research/run`,'POST',body)).json() as any;expect(first.id).toBe(second.id);
    const report=mockReport();const sources=[{id:'layout-source',title:'Official procurement source',url:'https://sam.gov',retrievedAt:'2026-10-20',kind:'opportunity',caveat:'Synthetic test only'}];
    const execute=vi.fn(async()=>({report,sources,usage:{input_tokens:123,output_tokens:456},discovery:[]}));
    expect(await processResearchJob(deps,execute)).toBe(true);expect(await processResearchJob(deps,execute)).toBe(false);expect(execute).toHaveBeenCalledTimes(1);
    expect((await db.one('SELECT status FROM research_runs'))!.status).toBe('completed');
    const doc=await request('member',`/api/opportunities/${opp}/research/${first.id}/report.docx`);expect(doc.status).toBe(200);const bytes=Buffer.from(await doc.arrayBuffer());expect(bytes.subarray(0,2).toString()).toBe('PK');
    const zip=await JSZip.loadAsync(bytes),xml=await zip.file('word/document.xml')!.async('string'),links=await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(xml).toContain('w:type="fixed"');expect(xml).toContain('w:tblHeader');expect(xml).toContain('w:keepNext');expect(xml).toContain('w:w="10080"');expect(links).toContain('https://sam.gov');
    for(const q of loadWorkflow().questions)expect(xml).toContain(q.id);
    const notifications=await (await request('member','/api/team/notifications')).json() as any;expect(notifications).toHaveLength(1);
    expect((await (await request('viewer','/api/team/notifications')).json() as any)).toHaveLength(0);
    expect((await request('member',`/api/opportunities/${opp}/research/${first.id}/review`,'POST',{})).status).toBe(403);
    expect((await request('manager',`/api/opportunities/${opp}/research/${first.id}/review`,'POST',{})).status).toBe(200);
    expect((await request('member',`/api/opportunities/${opp}/research/${first.id}/feedback`,'POST',{body:'Need current amendments'})).status).toBe(200);
    expect((await db.one('SELECT count(*)::int AS count FROM research_feedback'))!.count).toBe(1);
    const result=await (await request('member',`/api/opportunities/${opp}/research`)).json() as any;expect(result[0].report.answers.length).toBe(loadWorkflow().questions.length);
  });
  it('fails interrupted or invalid jobs without duplicating external calls; validates every answer and source',async()=>{
    const {db,opp,ids,deps}=await setup();
    const workflow=loadWorkflow();expect(workflow.questions.length).toBeGreaterThan(90);
    expect(()=>validateReport({...mockReport(),answers:[]},[])).toThrow();
    const bad=mockReport();bad.answers[0].status='VERIFIED_PRIMARY';expect(()=>validateReport(bad,[])).toThrow();
    await db.query("INSERT INTO research_runs(opportunity_id,origin_opportunity_id,initiated_by,skill_version,model,snapshot_hash,snapshot,status,lease_until) VALUES ($1,$1,$2,$3,'mock','hash','{}','running',now()-interval '1 minute')",[opp,ids.member,workflow.version]);
    const execute=vi.fn();expect(await processResearchJob(deps,execute)).toBe(false);expect(execute).not.toHaveBeenCalled();expect((await db.one('SELECT status,error FROM research_runs'))!.error).toContain('interrupted');
  });
});
function mockReport():any {return {executiveSummary:'Current solicitation not verified',conditionalRecommendation:'G0 pending human validation of mandatory gates',sections:RESEARCH_SECTIONS.map(title=>({title,text:'Open pending official evidence',sourceIds:[]})),answers:loadWorkflow().questions.map(q=>({id:q.id,answer:'Open pending official evidence',status:'OPEN',sourceIds:[],checkedOn:'2026-10-20',owner:'Assigned capture owner',evidenceRequest:q.question,urgency:'high'})),capabilityMatrix:[],risks:['Current solicitation not verified'],nextActions:[],queryLog:[]};}
