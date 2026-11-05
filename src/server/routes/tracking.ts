import type { Hono } from 'hono';
import { z } from 'zod';
import { DECISIONS, PURSUIT_STAGES } from '../../shared/domain';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { json } from '../db';
import { createResearchLead, DISCOVERY_PROVIDERS, recordMatchDecision, RESEARCH_LEAD_CONNECTOR } from '../pipeline/discovery';
import { familyOf } from '../pipeline/dossier';
import { setTracking, trackingState } from '../pipeline/tracking';
import { actor } from '../team/security';

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((u) => new URL(u).protocol === 'https:', 'Use an HTTPS source link');

/** Body of a research lead: only values a team member typed. `.strict()` rejects any provider payload. */
export const ResearchLeadInput = z
  .object({
    title: z.string().trim().min(3).max(300),
    notes: z.string().trim().max(10000).nullable().optional(),
    sourceUrl: httpsUrl,
    provider: z.enum(['g2x', 'tango', 'manual']),
    agency: z.string().trim().max(200).nullable().optional(),
    solicitationNumber: z.string().trim().max(100).nullable().optional(),
    responseDeadline: z.iso.date().nullable().optional(),
    naics: z.string().trim().regex(/^\d{2,6}$/).nullable().optional(),
    track: z.boolean().default(true),
    relateTo: z.object({ opportunityId: z.uuid(), type: z.enum(['predecessor', 'successor', 'related']) }).nullable().optional(),
    confirmUserAuthored: z.literal(true),
  })
  .strict();

const G2X_REF = /^g2x:[0-9a-f-]{36}$/i;
const isG2xLink = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)g2x\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
};

export function registerTrackingRoutes(app: Hono, deps: AppDeps) {
  const { db } = deps;
  /** Same rule as the capture / decision routes: managers, admins, or an active assignee (legacy single-user mode: allowed). */
  const canEditOpportunity = async (c: any, oppId: string) => {
    const user = actor(c);
    if (!user) return true;
    if (user.role === 'admin' || user.role === 'manager') return true;
    if (user.role !== 'member') return false;
    return !!(await db.one('SELECT 1 FROM opportunity_assignments WHERE opportunity_id = $1 AND user_id = $2 AND active', [oppId, user.user_id]));
  };
  const id = (raw: string) => {
    const r = z.uuid().safeParse(raw);
    if (!r.success) throw new HttpProblem(404, 'Opportunity not found');
    return r.data;
  };

  app.get('/api/opportunities/:id/tracking', async (c) => c.json(await trackingState(db, id(c.req.param('id')))));

  app.post('/api/opportunities/:id/track', async (c) => {
    const oppId = id(c.req.param('id'));
    const b = z
      .object({
        tracked: z.boolean(),
        requestId: z.uuid().optional(),
        decision: z.enum(DECISIONS).optional(),
        captureStage: z.enum(PURSUIT_STAGES).optional(),
        priority: z.enum(['high', 'medium', 'low']).optional(),
      })
      .strict()
      .parse(await readJson(c));
    const user = actor(c)?.user_id ?? null;
    // Members may start tracking anything. Untracking, and setting the decision / capture stage / priority,
    // follow the same rule as the capture and decision routes: an assignee or a manager.
    const editor = await canEditOpportunity(c, oppId);
    if (!b.tracked && !editor) throw new HttpProblem(403, 'Only an assignee or a manager can stop tracking this opportunity.');
    if ((b.decision || b.captureStage || b.priority) && !editor) throw new HttpProblem(403, 'Only an assignee or a manager can set the decision, capture stage or priority.');
    try {
      await setTracking(db, oppId, { tracked: b.tracked, actorId: user, requestId: b.requestId });
    } catch (err) {
      throw new HttpProblem(409, (err as Error).message);
    }
    if (b.tracked && (b.captureStage || b.priority)) {
      const prev = await db.one<any>('SELECT pursuit_stage, priority FROM opportunity_capture WHERE opportunity_id = $1', [oppId]);
      await db.query('UPDATE opportunity_capture SET pursuit_stage = COALESCE($2, pursuit_stage), priority = COALESCE($3, priority), actor_id = $4, updated_at = now() WHERE opportunity_id = $1', [oppId, b.captureStage ?? null, b.priority ?? null, user]);
      await db.query('INSERT INTO opportunity_capture_history (opportunity_id, changes, actor_id) VALUES ($1,$2::jsonb,$3)', [oppId, json({ via: 'track', before: prev, pursuit_stage: b.captureStage, priority: b.priority }), user]);
    }
    if (b.tracked && b.decision && !(await db.one('SELECT 1 FROM user_opportunity_decisions WHERE opportunity_id = $1 AND is_current', [oppId])))
      await db.query('INSERT INTO user_opportunity_decisions (opportunity_id, decision, is_current, actor_id) VALUES ($1,$2,true,$3)', [oppId, b.decision, user]);
    return c.json(await trackingState(db, oppId));
  });

  app.post('/api/research-leads', async (c) => {
    const user = actor(c);
    if (user?.role === 'viewer') throw new HttpProblem(403, 'View-only account.');
    const b = ResearchLeadInput.parse(await readJson(c));
    if (b.provider === 'g2x' && !/(^|\.)g2x\.com$/i.test(new URL(b.sourceUrl).hostname)) throw new HttpProblem(400, 'A G2X research lead must link to the G2X record (g2x.com).');
    if (b.relateTo && !(await db.one('SELECT 1 FROM opportunities WHERE id = $1 AND merged_into_id IS NULL', [b.relateTo.opportunityId]))) throw new HttpProblem(404, 'Related opportunity not found');
    // A confirmed predecessor/successor link changes someone else's opportunity; without edit rights it is only suggested for review.
    const relateConfirmed = b.relateTo ? await canEditOpportunity(c, b.relateTo.opportunityId) : false;
    const out = await createResearchLead(db, { ...b, relateConfirmed }, user?.user_id ?? null);
    return c.json({ ...out, verification: 'research_lead', labels: ['Research lead', 'Not government verified', 'No official solicitation confirmed', `Source discovery: ${DISCOVERY_PROVIDERS[b.provider].label}`] }, out.created ? 201 : 200);
  });

  /** Record a user decision about a discovery result (Potential Match review). Nothing from the provider is stored. */
  app.post('/api/discovery/decision', async (c) => {
    const user = actor(c);
    if (user?.role === 'viewer') throw new HttpProblem(403, 'View-only account.');
    const b = z
      .object({
        provider: z.enum(['g2x', 'tango', 'manual']),
        recordRef: z.string().trim().min(3).max(2000),
        recordUrl: httpsUrl.nullable().optional(),
        opportunityId: z.uuid().nullable(),
        decision: z.enum(['linked', 'separate', 'predecessor', 'successor', 'dismissed']),
      })
      .strict()
      .parse(await readJson(c));
    if (b.decision !== 'dismissed' && !b.opportunityId) throw new HttpProblem(400, 'Choose the GovCheck opportunity this decision applies to.');
    if (b.provider === 'g2x') {
      if (!isG2xLink(b.recordRef) && !G2X_REF.test(b.recordRef)) throw new HttpProblem(400, 'A G2X decision must reference a g2x.com record link.');
      if (b.recordUrl && !isG2xLink(b.recordUrl)) throw new HttpProblem(400, 'A G2X record link must be an HTTPS g2x.com URL.');
    }
    // Linking attaches discovery attribution to an opportunity, so it needs edit rights on that opportunity.
    if (b.decision === 'linked' && b.opportunityId && !(await canEditOpportunity(c, b.opportunityId))) throw new HttpProblem(403, 'Only an assignee or a manager can link a discovery result to this opportunity.');
    await recordMatchDecision(db, { ...b, opportunityId: b.opportunityId, actorId: user?.user_id ?? null });
    return c.json({ ok: true });
  });

  /** Potential matches for one opportunity: suggested duplicates/same-procurement links with evidence and conflicts. */
  app.get('/api/opportunities/:id/potential-matches', async (c) => {
    const oppId = id(c.req.param('id'));
    const me = await db.one<any>('SELECT id, department_name, stage, response_deadline, solicitation_number, verification_status FROM opportunities WHERE id = $1', [oppId]);
    if (!me) throw new HttpProblem(404, 'Opportunity not found');
    const rows = await db.query<any>(
      `SELECT r.id AS relationship_id, r.relationship_type, r.confidence, r.evidence, r.method, o.id, o.title, o.stage, o.status, o.department_name, o.solicitation_number, o.response_deadline, o.connector_ids, o.verification_status
       FROM opportunity_relationships r JOIN opportunities o ON o.id = CASE WHEN r.from_opportunity_id = $1 THEN r.to_opportunity_id ELSE r.from_opportunity_id END
       WHERE (r.from_opportunity_id = $1 OR r.to_opportunity_id = $1) AND r.status = 'suggested' AND o.merged_into_id IS NULL
         AND r.relationship_type IN ('possible_duplicate','possible_same_procurement','possible_predecessor','forecast_of')
       ORDER BY r.confidence DESC NULLS LAST LIMIT 20`,
      [oppId],
    );
    return c.json(
      rows.map((r) => ({
        ...r,
        conflicts: [
          ...(me.department_name && r.department_name && me.department_name.toUpperCase() !== r.department_name.toUpperCase() ? [`Agency: "${me.department_name}" vs "${r.department_name}"`] : []),
          ...(me.solicitation_number && r.solicitation_number && me.solicitation_number !== r.solicitation_number ? [`Solicitation number: ${me.solicitation_number} vs ${r.solicitation_number}`] : []),
          ...((me.stage === 'award') !== (r.stage === 'award') ? ['One record is an award: treat as predecessor/successor rather than the same procurement unless the award is for this solicitation'] : []),
        ],
      })),
    );
  });

  /** Dynamic source registry for filters and badges (built from the connector table, not a hardcoded list). */
  app.get('/api/sources/registry', async (c) => {
    const connectors = await db.query<{ id: string; name: string; source_type: string; access_method: string; enabled: boolean }>(
      `SELECT id, name, source_type, access_method, enabled FROM source_connectors WHERE source_type <> 'engine' ORDER BY priority, name`,
    );
    const used = await db.query<{ provider: string }>('SELECT DISTINCT provider FROM opportunity_discovery');
    const providers = new Set([...used.map((u) => u.provider), ...(deps.config.g2xEnabled ? ['g2x'] : [])]);
    return c.json([
      ...connectors.map((r) => ({ id: r.id, label: r.id === RESEARCH_LEAD_CONNECTOR ? 'Research lead (user)' : r.name, family: familyOf(r.id, r.name).label, kind: r.id === RESEARCH_LEAD_CONNECTOR ? 'user' : 'official_or_feed', enabled: r.enabled })),
      ...[...providers].filter((p) => DISCOVERY_PROVIDERS[p]).map((p) => ({ id: p, label: `${DISCOVERY_PROVIDERS[p].label} discovery`, family: DISCOVERY_PROVIDERS[p].label, kind: 'discovery', enabled: true })),
    ]);
  });
}
