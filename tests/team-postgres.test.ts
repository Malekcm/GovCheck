import crypto from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { createApp } from '../src/server/app';
import { createDb } from '../src/server/db';
import { runMigrations } from '../src/server/db/migrate';
import { digest,seal } from '../src/server/team/security';
import { mergeOpportunities,undoMerge } from '../src/server/pipeline/merge';
import { loadWorkflow,processResearchJob } from '../src/server/research/workflow';
import { testDeps } from './helpers/setup';
import { PG_URL,withTempDatabase } from './helpers/pg';

vi.mock('@supabase/supabase-js',()=>({createClient:()=>({auth:{getUser:async(token:string)=>({data:{user:{id:token}},error:null})}})}));

describe.skipIf(!PG_URL)('native PostgreSQL team collaboration',()=>{
  it('serializes competing assignments, preserves merge undo, claims research once and revokes deactivated access',async()=>{
    await withTempDatabase(async databaseUrl=>{
      const db=await createDb({databaseUrl,pgliteDir:''});
      try {
        await runMigrations(db,'migrations');
        const manager=crypto.randomUUID(),member=crypto.randomUUID(),token=crypto.randomUUID();
        for(const [id,role] of [[manager,'manager'],[member,'member']])await db.query('INSERT INTO team_members(user_id,organization_id,email,name,role) SELECT $1,id,$2,$3,$3 FROM organizations LIMIT 1',[id,`${role}@test.gov`,role]);
        const deps=await testDeps(db,undefined,{teamAuthEnabled:true,supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'public',supabaseServiceKey:'server',sessionSecret:'native-test-only-encryption-secret-long-enough'});
        await db.query("INSERT INTO team_sessions(id,user_id,credentials,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",[digest(token),manager,seal(deps.config.sessionSecret,{access_token:manager,expires_at:Date.now()/1000+3600})]);
        const app=createApp(deps);
        const opportunity=async(title:string)=>(await db.one("INSERT INTO opportunities(title,opportunity_class,stage,status) VALUES ($1,'prime','forecast','forecast') RETURNING id",[title]))!.id;
        const primary=await opportunity('Native shared profile'),secondary=await opportunity('Secondary profile');
        const put=(id:string,userId:string)=>app.request(`/api/opportunities/${id}/assignments`,{method:'PUT',headers:{Cookie:`govcheck_team=${token}`,'Content-Type':'application/json'},body:JSON.stringify({revision:0,requestId:crypto.randomUUID(),assignments:[{userId,role:'owner',status:'Not Started',nextAction:null,dueDate:null}]})});
        const responses=await Promise.all([put(primary,manager),put(primary,member)]);
        expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
        const owner=await db.one('SELECT user_id FROM opportunity_assignments WHERE opportunity_id=$1 AND active',[primary]);
        const other=owner.user_id===manager?member:manager;
        expect((await put(secondary,other)).status).toBe(200);
        const mergeId=await mergeOpportunities(db,primary,secondary,new Map(),'Native merge',manager);
        expect((await db.one("SELECT count(*)::int AS n FROM opportunity_assignments WHERE opportunity_id=$1 AND active AND assignment_role='owner'",[primary]))!.n).toBe(1);
        await undoMerge(db,mergeId,new Map(),manager);
        expect((await db.one('SELECT user_id FROM opportunity_assignments WHERE opportunity_id=$1 AND active',[secondary]))!.user_id).toBe(other);
        await db.query("INSERT INTO research_runs(opportunity_id,origin_opportunity_id,initiated_by,skill_version,model,snapshot_hash,snapshot) VALUES ($1,$1,$2,$3,'mock','native','{}')",[primary,manager,loadWorkflow().version]);
        const execute=vi.fn(async()=>{throw new Error('Deliberate mock provider failure');});
        const claims=await Promise.all([processResearchJob(deps,execute),processResearchJob(deps,execute)]);
        expect(claims.sort()).toEqual([false,true]);expect(execute).toHaveBeenCalledTimes(1);
        expect((await db.one('SELECT status FROM research_runs'))!.status).toBe('failed');
        const fresh=createApp(deps);
        expect((await fresh.request(`/api/opportunities/${primary}/assignments`,{headers:{Cookie:`govcheck_team=${token}`}})).status).toBe(200);
        await db.query('UPDATE team_members SET active=false WHERE user_id=$1',[manager]);
        expect((await fresh.request('/api/company',{headers:{Cookie:`govcheck_team=${token}`}})).status).toBe(401);
        const tables=await db.query("SELECT relrowsecurity FROM pg_class WHERE relname=ANY($1::text[])",[['team_members','team_sessions','opportunity_assignments','assignment_history','research_runs','g2x_connections','oauth_states','research_feedback','team_notifications']]);
        expect(tables).toHaveLength(9);expect(tables.every(t=>t.relrowsecurity)).toBe(true);
      } finally {await db.close();}
    });
  });
});
