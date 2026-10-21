import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { actor } from '../team/security';
import { json } from '../db';
import { evidenceSnapshot, loadWorkflow, runningResearchControllers } from './workflow';
import { reportDocx } from './word';

export function registerResearchRoutes(app: Hono, deps: AppDeps) {
  app.get('/api/team/notifications',async c=>c.json(await deps.db.query(`SELECT n.id,n.created_at,r.opportunity_id,o.title FROM team_notifications n JOIN research_runs r ON r.id=n.research_run_id JOIN opportunities o ON o.id=r.opportunity_id WHERE n.user_id=$1 AND n.read_at IS NULL ORDER BY n.created_at DESC LIMIT 30`,[actor(c)!.user_id])));
  app.post('/api/team/notifications/:id/read',async c=>{
    await deps.db.query('UPDATE team_notifications SET read_at=now() WHERE id=$1 AND user_id=$2',[z.uuid().parse(c.req.param('id')),actor(c)!.user_id]);return c.json({ok:true});
  });
  const ready = () => {
    if (!deps.config.researchEnabled || !deps.config.anthropicApiKey) throw new HttpProblem(503,'Research is disabled. Configure the provider and enable research after reviewing data sharing and costs.');
  };
  app.get('/api/opportunities/:id/research', async c => c.json(await deps.db.query(`SELECT r.id,r.status,r.skill_version,r.model,r.snapshot_hash,r.created_at,r.completed_at,r.report,r.error,r.usage,m.name AS initiated_by_name,v.name AS reviewed_by_name,r.reviewed_at
    FROM research_runs r JOIN team_members m ON m.user_id=r.initiated_by LEFT JOIN team_members v ON v.user_id=r.reviewed_by WHERE opportunity_id=$1 ORDER BY created_at DESC`, [z.uuid().parse(c.req.param('id'))])));
  app.get('/api/opportunities/:id/research/:runId/feedback',async c=>c.json(await deps.db.query(`SELECT f.id,f.body,f.created_at,m.name FROM research_feedback f JOIN team_members m ON m.user_id=f.user_id JOIN research_runs r ON r.id=f.research_run_id WHERE f.research_run_id=$1 AND r.opportunity_id=$2 ORDER BY f.created_at DESC`,[z.uuid().parse(c.req.param('runId')),z.uuid().parse(c.req.param('id'))])));
  app.post('/api/opportunities/:id/research/preview', async c => {
    ready();
    const { snapshot,hash } = await evidenceSnapshot(deps,z.uuid().parse(c.req.param('id')));
    return c.json({ hash,skillVersion:loadWorkflow().version,company:snapshot.company.name,sourceCount:snapshot.sources.length,documentCount:snapshot.documents.length,
      missing:[...(!snapshot.company.configured ? ['Company capabilities and approved past performance'] : []),...(!snapshot.documents.length ? ['Current solicitation documents and amendments'] : [])],
      model:deps.config.anthropicModel,
      cost: { currency:'USD',estimate:deps.config.researchEstimatedCostUsd ?? null,notice:'Two bounded model requests, up to eight public government web searches. Estimate is administrator configured; actual usage varies. No automatic retries.' },
      externalUsage:'Anthropic receives the selected company profile, assigned team member names and public government evidence. Web search is restricted to government sources. G2X and Tango content are excluded.' });
  });
  app.post('/api/opportunities/:id/research/run', async c => {
    ready();
    const b = z.object({ hash:z.string().length(64),skillVersion:z.string(),model:z.string(),approvedCostUsd:z.number().positive(),acknowledgeExternalUsage:z.literal(true),acknowledgeEstimatedCost:z.literal(true) }).strict().parse(await readJson(c));
    const id = z.uuid().parse(c.req.param('id'));
    const { snapshot,hash } = await evidenceSnapshot(deps,id);
    const workflow = loadWorkflow();
    if (hash !== b.hash || b.skillVersion !== workflow.version) throw new HttpProblem(409,'Evidence or workflow changed. Review a new scope preview.');
    if (deps.config.researchEstimatedCostUsd == null) throw new HttpProblem(503,'An administrator must configure the expected research cost before research can start.');
    if(b.model!==deps.config.anthropicModel||b.approvedCostUsd!==deps.config.researchEstimatedCostUsd)throw new HttpProblem(409,'Model or expected cost changed. Review a new scope preview.');
    const run = await deps.db.tx(async tx => {
      const opp = await tx.one('SELECT merged_into_id FROM opportunities WHERE id=$1 FOR UPDATE',[id]);
      if (opp?.merged_into_id) throw new HttpProblem(409,'Opportunity merged. Reload before researching.');
      const existing = await tx.one('SELECT id,status FROM research_runs WHERE opportunity_id=$1 AND snapshot_hash=$2 AND skill_version=$3 ORDER BY created_at LIMIT 1',[id,hash,workflow.version]);
      if (existing) return existing;
      return tx.one(`INSERT INTO research_runs(opportunity_id,origin_opportunity_id,initiated_by,skill_version,model,snapshot_hash,snapshot) VALUES ($1,$1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT(origin_opportunity_id,snapshot_hash,skill_version) DO UPDATE SET snapshot_hash=EXCLUDED.snapshot_hash RETURNING id,status`,[id,actor(c)!.user_id,workflow.version,deps.config.anthropicModel,hash,json({...snapshot,approval:{estimatedCostUsd:b.approvedCostUsd,model:b.model,externalUsageApproved:true,approvedAt:new Date().toISOString()}})]);
    });
    return c.json(run,202);
  });
  app.post('/api/opportunities/:id/research/:runId/:action', async c => {
    const id = z.uuid().parse(c.req.param('id'));
    const runId = z.uuid().parse(c.req.param('runId'));
    const action = z.enum(['cancel','retry','review','feedback']).parse(c.req.param('action'));
    const run = await deps.db.one('SELECT * FROM research_runs WHERE id=$1 AND opportunity_id=$2',[runId,id]);
    if (!run) throw new HttpProblem(404,'Research run not found.');
    if(action==='feedback') {
      const b=z.object({body:z.string().trim().min(1).max(10000)}).strict().parse(await readJson(c));
      await deps.db.query('INSERT INTO research_feedback(research_run_id,user_id,body) VALUES ($1,$2,$3)',[runId,actor(c)!.user_id,b.body]);
    } else if (action === 'review') {
      if (!['admin','manager'].includes(actor(c)!.role)) throw new HttpProblem(403,'Manager review required.');
      if (run.status !== 'completed') throw new HttpProblem(409,'Only completed reports can be reviewed.');
      await deps.db.query('UPDATE research_runs SET reviewed_by=$2,reviewed_at=now() WHERE id=$1',[runId,actor(c)!.user_id]);
    } else if (action === 'retry') {
      ready();
      z.object({ acknowledgePossiblePriorCost:z.literal(true) }).parse(await readJson(c));
      await deps.db.query("UPDATE research_runs SET status='queued',error=NULL,completed_at=NULL,lease_until=NULL,claim_id=NULL WHERE id=$1 AND status='failed'",[runId]);
    } else {
      await deps.db.query("UPDATE research_runs SET status='cancelled',completed_at=now() WHERE id=$1 AND status IN ('queued','running')",[runId]);
      runningResearchControllers.get(runId)?.abort();
    }
    return c.json({ ok:true });
  });
  app.get('/api/opportunities/:id/research/:runId/report.docx', async c => {
    const run = await deps.db.one('SELECT r.*,m.name AS initiated_by_name FROM research_runs r JOIN team_members m ON m.user_id=r.initiated_by WHERE r.id=$1 AND r.opportunity_id=$2 AND r.status=\'completed\'',[z.uuid().parse(c.req.param('runId')),z.uuid().parse(c.req.param('id'))]);
    if (!run) throw new HttpProblem(404,'Completed report not found.');
    const buffer = await reportDocx(run);
    return new Response(new Uint8Array(buffer),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="GovCheck-capture-${run.id}.docx"`,'Cache-Control':'no-store'}});
  });
}
