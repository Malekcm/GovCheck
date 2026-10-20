import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { TangoClient, TangoQuery, previewTango, TANGO_FILTERS, type TangoTransport } from '../connectors/tango';
import { TangoBudget, TangoBlocked } from '../pipeline/tangoBudget';
import { matchResearch } from '../pipeline/researchMatching';
import { loadCompanyContext } from '../scoring/profile';

export function registerTangoRoutes(app: Hono, deps: AppDeps, transport?: TangoTransport) {
  const { db, config } = deps;
  const budget = new TangoBudget(db, config.tango);
  const client = new TangoClient(db, config, transport);
  const guarded = async <T>(fn: () => Promise<T>) => {
    try { return await fn(); } catch (error) {
      if (error instanceof TangoBlocked) throw new HttpProblem(409, error.message);
      throw error;
    }
  };
  app.get('/api/tango/status', async c => {
    const company = await loadCompanyContext(db);
    return c.json({ ...await budget.status(), filters: TANGO_FILTERS,
      suggestedNaics: company.naics.slice(0, 5), suggestedKeywords: company.capabilities.slice(0, 5).map(x => x.name),
      g2xEntitlement: 'Account must belong to G2X User group; HTTP 403 means access must be verified with MakeGov.' });
  });
  app.post('/api/tango/preview', async c => {
    const input = await readJson(c);
    return c.json(await guarded(async () => previewTango(input)));
  });
  app.post('/api/tango/research', async c => {
    const body = z.object({ query: TangoQuery, fingerprint: z.string().length(64) }).strict().parse(await readJson(c));
    const result = await guarded(() => client.research(body.query, body.fingerprint));
    const records = await Promise.all(result.records.map(async row => ({ data: row, matches: await matchResearch(db, row) })));
    return c.json({ ...result, records });
  });
  app.post('/api/tango/test', async c => {
    const body = z.object({ acknowledgeRequestCost: z.literal(true) }).strict().parse(await readJson(c));
    void body;
    const plan = previewTango({ resource: 'forecasts', filters: { agency: 'DOT' }, limit: 1, maxPages: 1 });
    const result = await guarded(() => client.research(plan.query, plan.fingerprint, 'test'));
    return c.json({ ok: true, requests: result.requests, budget: result.budget, message: 'Authentication and forecast response shape validated (one request).' });
  });
  app.post('/api/tango/clear-auth-block', async c => {
    z.object({ keyVerified: z.literal(true) }).strict().parse(await readJson(c));
    await db.query(`UPDATE tango_budget SET auth_blocked=false WHERE account_id='tango'`);
    return c.json({ ok: true });
  });
  // Only independently authored research is persisted. No Tango source or payload field exists.
  const signal = z.object({
    sourceName: z.enum(['OrangeSlices','Manual']), sourceUrl: z.string().url().max(2000).refine(u => new URL(u).protocol === 'https:', 'Use an HTTPS source link'),
    opportunityId: z.string().uuid().nullable().default(null), companyId: z.string().uuid().nullable().default(null),
    category: z.enum(['forecast','vehicle','subaward','company','award','opportunity','news','event','other']),
    notes: z.string().trim().min(1).max(4000), confidence: z.number().min(0).max(1).default(0),
    verificationStatus: z.enum(['unverified','verified','rejected']).default('unverified'),
    reviewStatus: z.enum(['pending','reviewed','dismissed']).default('pending'),
    observedAt: z.string().datetime().optional(), independentlyAuthored: z.literal(true),
  }).strict().refine(b => b.sourceName !== 'OrangeSlices' || /(^|\.)orangeslices\.ai$/.test(new URL(b.sourceUrl).hostname), 'OrangeSlices links must use orangeslices.ai');
  app.get('/api/research/signals', async c => c.json(await db.query('SELECT * FROM research_signals ORDER BY observed_at DESC LIMIT 100')));
  app.post('/api/research/signals', async c => {
    const b = signal.parse(await readJson(c));
    const row = await db.one(`INSERT INTO research_signals(source_name,source_url,opportunity_id,company_id,category,notes,confidence,verification_status,review_status,observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz,clock_timestamp())) RETURNING id`,
    [b.sourceName,b.sourceUrl,b.opportunityId,b.companyId,b.category,b.notes,b.confidence,b.verificationStatus,b.reviewStatus,b.observedAt ?? null]);
    return c.json(row, 201);
  });
  app.put('/api/research/signals/:id', async c => {
    const b = z.object({ reviewStatus: z.enum(['pending','reviewed','dismissed']), verificationStatus: z.enum(['unverified','verified','rejected']), notes: z.string().trim().min(1).max(4000), independentlyAuthored: z.literal(true) }).strict().parse(await readJson(c));
    const id = z.string().uuid().parse(c.req.param('id'));
    const row = await db.one(`UPDATE research_signals SET review_status=$2,verification_status=$3,notes=$4 WHERE id=$1 RETURNING id`, [id,b.reviewStatus,b.verificationStatus,b.notes]);
    if (!row) throw new HttpProblem(404, 'Research note not found');
    return c.json(row);
  });
}
