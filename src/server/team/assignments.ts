import { stableStringify } from '../lib/hash';
import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { actor } from './security';
import { json, type Db } from '../db';

const Assignment = z.object({
  userId: z.uuid(), role: z.enum(['owner','collaborator']),
  status: z.enum(['Not Started','Researching','Awaiting Review','Complete','Blocked']),
  nextAction: z.string().trim().max(1000).nullable(), dueDate: z.iso.date().nullable(),
}).strict();
export const AssignmentInput = z.object({ requestId: z.uuid(), revision: z.number().int().min(0), assignments: z.array(Assignment).max(100) }).strict()
  .refine(b => b.assignments.filter(a => a.role === 'owner').length <= 1, 'Only one primary owner is allowed.')
  .refine(b => new Set(b.assignments.map(a => a.userId)).size === b.assignments.length, 'Duplicate assignees.');

export async function assignmentState(db: Db, id: string) {
  const opportunity = await db.one('SELECT assignment_revision,merged_into_id FROM opportunities WHERE id::text=$1', [id]);
  if (!opportunity) throw new HttpProblem(404, 'Opportunity not found.');
  if (opportunity.merged_into_id) throw new HttpProblem(409, `Open the surviving opportunity ${opportunity.merged_into_id}.`);
  return { revision: opportunity.assignment_revision,
    assignments: await db.query(`SELECT a.*,m.name,m.email,editor.name AS assigned_by_name FROM opportunity_assignments a JOIN team_members m ON m.user_id=a.user_id LEFT JOIN team_members editor ON editor.user_id=a.assigned_by WHERE opportunity_id=$1 AND a.active ORDER BY assignment_role DESC,m.name`, [id]),
    history: await db.query('SELECT h.*,m.name AS actor_name FROM assignment_history h LEFT JOIN team_members m ON m.user_id=h.actor_id WHERE opportunity_id=$1 ORDER BY created_at DESC LIMIT 50', [id]) };
}
export function registerAssignmentRoutes(app: Hono, deps: AppDeps) {
  app.post('/api/opportunities/:id/claim', async c => {
    const id=z.uuid().parse(c.req.param('id')),user=actor(c)!;
    await deps.db.tx(async tx=>{
      const opp=await tx.one('SELECT merged_into_id FROM opportunities WHERE id=$1 FOR UPDATE',[id]);
      if(!opp||opp.merged_into_id)throw new HttpProblem(409,'Opportunity changed. Reload the surviving profile.');
      const rows=await tx.query('SELECT * FROM opportunity_assignments WHERE opportunity_id=$1 AND active',[id]);
      if(rows.some(row=>row.assignment_role==='owner'&&row.user_id===user.user_id))return;
      if(rows.some(row=>row.assignment_role==='owner'))throw new HttpProblem(409,'This opportunity already has an owner. Ask a manager to add you as a collaborator.');
      const before=rows;
      await tx.query('UPDATE opportunity_assignments SET active=false,version=version+1 WHERE opportunity_id=$1 AND user_id=$2 AND active',[id,user.user_id]);
      await tx.query("INSERT INTO opportunity_assignments(opportunity_id,user_id,assignment_role,assigned_by) VALUES ($1,$2,'owner',$2)",[id,user.user_id]);
      await tx.query('UPDATE opportunities SET assignment_revision=assignment_revision+1 WHERE id=$1',[id]);
      await tx.query('INSERT INTO assignment_history(opportunity_id,actor_id,request_id,changes) VALUES ($1,$2,gen_random_uuid(),$3::jsonb)',[id,user.user_id,json({type:'self_claim',before,request:[{userId:user.user_id,role:'owner',status:'Not Started',nextAction:null,dueDate:null}]})]);
    });
    return c.json(await assignmentState(deps.db,id));
  });
  app.put('/api/opportunities/:id/assignment-progress/:assignmentId', async c => {
    const b = Assignment.omit({ userId:true,role:true }).parse(await readJson(c));
    const id=z.uuid().parse(c.req.param('id')),assignmentId=z.uuid().parse(c.req.param('assignmentId'));
    await deps.db.tx(async tx=>{
      const opp=await tx.one('SELECT merged_into_id FROM opportunities WHERE id=$1 FOR UPDATE',[id]);
      if(!opp||opp.merged_into_id)throw new HttpProblem(409,'Opportunity changed. Reload.');
      const row=await tx.one('SELECT * FROM opportunity_assignments WHERE id=$1 AND opportunity_id=$2 AND user_id=$3 AND active FOR UPDATE',[assignmentId,id,actor(c)!.user_id]);
      if(!row)throw new HttpProblem(403,'Only your own active assignment can be updated here.');
      await tx.query('UPDATE opportunity_assignments SET status=$2,next_action=$3,due_date=$4,version=version+1 WHERE id=$1',[assignmentId,b.status,b.nextAction,b.dueDate]);
      await tx.query('UPDATE opportunities SET assignment_revision=assignment_revision+1 WHERE id=$1',[id]);
      await tx.query('INSERT INTO assignment_history(opportunity_id,actor_id,request_id,changes) VALUES ($1,$2,gen_random_uuid(),$3::jsonb)',[id,actor(c)!.user_id,json({before:[row],request:[{...b,userId:row.user_id,role:row.assignment_role}]})]);
    });
    return c.json({ok:true});
  });
  app.get('/api/opportunities/:id/assignments', async c => c.json(await assignmentState(deps.db, z.uuid().parse(c.req.param('id')))));
  app.put('/api/opportunities/:id/assignments', async c => {
    const id = z.uuid().parse(c.req.param('id'));
    const b = AssignmentInput.parse(await readJson(c));
    await deps.db.tx(async tx => {
      const opp = await tx.one('SELECT assignment_revision,merged_into_id FROM opportunities WHERE id=$1 FOR UPDATE', [id]);
      if (!opp) throw new HttpProblem(404, 'Opportunity not found.');
      if (opp.merged_into_id) throw new HttpProblem(409, 'Opportunity was merged. Reload the surviving profile.');
      const request = await tx.one('SELECT * FROM assignment_history WHERE request_id=$1', [b.requestId]);
      if (request) {
        if (request.opportunity_id !== id || request.actor_id !== actor(c)!.user_id || stableStringify(request.changes.request) !== stableStringify(b.assignments)) throw new HttpProblem(409, 'Idempotency key was reused for a different change.');
        return;
      }
      if (opp.assignment_revision !== b.revision) throw new HttpProblem(409, 'Assignments changed. Reload before saving.');
      for (const a of b.assignments) if (!await tx.one('SELECT 1 FROM team_members WHERE user_id=$1 AND organization_id=$2 AND active', [a.userId, actor(c)!.organization_id])) throw new HttpProblem(400, 'Assignee must be an active team member.');
      const before = await tx.query('SELECT * FROM opportunity_assignments WHERE opportunity_id=$1 AND active', [id]);
      await tx.query('UPDATE opportunity_assignments SET active=false,version=version+1 WHERE opportunity_id=$1 AND active', [id]);
      for (const a of b.assignments) {
        const previous=before.find(row=>row.user_id===a.userId);
        if(previous) {
          const roleChanged=previous.assignment_role!==a.role;
          await tx.query(`UPDATE opportunity_assignments SET active=true,assignment_role=$2,status=$3,next_action=$4,due_date=$5,
            assigned_by=CASE WHEN $6 THEN $7::uuid ELSE assigned_by END,assigned_at=CASE WHEN $6 THEN now() ELSE assigned_at END WHERE id=$1`,
          [previous.id,a.role,a.status,a.nextAction,a.dueDate,roleChanged,actor(c)!.user_id]);
        } else await tx.query(`INSERT INTO opportunity_assignments(opportunity_id,user_id,assignment_role,status,next_action,due_date,assigned_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id,a.userId,a.role,a.status,a.nextAction,a.dueDate,actor(c)!.user_id]);
      }
      await tx.query('UPDATE opportunities SET assignment_revision=assignment_revision+1 WHERE id=$1', [id]);
      await tx.query('INSERT INTO assignment_history(opportunity_id,actor_id,request_id,changes) VALUES ($1,$2,$3,$4::jsonb)', [id, actor(c)!.user_id,b.requestId,json({ before, request: b.assignments })]);
    });
    return c.json(await assignmentState(deps.db, id));
  });
  app.get('/api/team/workload', async c => {
    const my = c.req.query('mine') === 'true';
    return c.json(await deps.db.query(`SELECT m.user_id,m.name,m.email,a.id AS assignment_id,a.assignment_role,a.status,a.next_action,a.due_date,a.assigned_at,
      o.id AS opportunity_id,o.title,o.stage,cap.pursuit_stage,(a.due_date<current_date AND a.status<>'Complete') AS overdue
      FROM team_members m LEFT JOIN opportunity_assignments a ON a.user_id=m.user_id AND a.active
      LEFT JOIN opportunities o ON o.id=a.opportunity_id AND o.merged_into_id IS NULL LEFT JOIN opportunity_capture cap ON cap.opportunity_id=o.id
      WHERE m.organization_id=$1 AND m.active AND ($2::uuid IS NULL OR m.user_id=$2)
      ORDER BY m.name,a.due_date NULLS LAST`, [actor(c)!.organization_id,my ? actor(c)!.user_id : null]));
  });
}
