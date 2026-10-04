import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { SAM_BUDGET_KEY } from '../connectors/sam/samOpportunities';
import { samBudgetStatus } from '../pipeline/budget';
import { executeLiveSearch, LiveSearchRefused, planLiveSearch, SAM_NOTICE_TYPES, SAM_SET_ASIDES, searchLocal, TargetedFilters } from '../pipeline/targetedSearch';

/**
 * Targeted search API.
 *
 *   POST /api/targeted-search/preview  searches GovCheck's database and returns the live-search
 *                                      plan (requests, budget, parameters). Never contacts SAM.
 *   POST /api/targeted-search/live     runs the live SAM search; requires { confirm: true }.
 */
export function registerSearchRoutes(app: Hono, deps: AppDeps) {
  const { db, config } = deps;

  app.get('/api/targeted-search/options', (c) =>
    c.json({ noticeTypes: SAM_NOTICE_TYPES, setAsides: SAM_SET_ASIDES, defaultMaxRequests: config.samTargetedSearchMaxRequests, samConfigured: !!config.samApiKey }),
  );

  app.post('/api/targeted-search/preview', async (c) => {
    const b = z.object({ filters: TargetedFilters, maxRequests: z.number().int().min(1).max(1000).optional() }).parse(await readJson(c));
    const maxRequests = Math.min(b.maxRequests ?? config.samTargetedSearchMaxRequests, config.samDailyRequestLimit);
    const local = await searchLocal(db, b.filters);
    const plan = planLiveSearch(b.filters, maxRequests);
    const budget = await samBudgetStatus(db, config);
    return c.json({
      local,
      live: {
        configured: !!config.samApiKey,
        plan: { ...plan, calls: plan.calls.map((p) => ({ ...p })) }, // parameters only — the API key is added server-side at request time
        budget: { limit: budget.limit, used: budget.used, remaining: budget.remaining, reserve: budget.reserve, resetsAt: budget.resetsAt },
        affordable: plan.estimatedRequests <= budget.remaining,
      },
    });
  });

  app.post('/api/targeted-search/live', async (c) => {
    const b = z.object({ filters: TargetedFilters, maxRequests: z.number().int().min(1).max(1000).optional(), confirm: z.literal(true) }).safeParse(await readJson(c));
    if (!b.success) throw new HttpProblem(400, 'A live SAM.gov search needs the filters and an explicit confirmation (confirm: true).');
    try {
      const result = await executeLiveSearch(deps, b.data.filters, { maxRequests: b.data.maxRequests, confirm: b.data.confirm });
      return c.json({ ...result, budgetRemaining: await deps.budget.remaining(SAM_BUDGET_KEY) });
    } catch (err) {
      if (err instanceof LiveSearchRefused) throw new HttpProblem(err.status, err.message);
      throw err;
    }
  });

  app.get('/api/targeted-search/history', async (c) =>
    c.json(
      await db.query(
        `SELECT id, filters, sam_params, status, requests_used, requests_planned, results_returned, results_kept, records_new, records_changed, message, created_at,
           cardinality(opportunity_ids) AS opportunities FROM targeted_searches ORDER BY created_at DESC LIMIT 50`,
      ),
    ),
  );
}
