import type { Hono } from 'hono';
import type { AppDeps } from '../app';
import { json } from '../db';
import { buildOpportunityQuery, DECISION_JOIN, OpportunityFilters } from './query';

export async function getLastVisit(deps: AppDeps): Promise<string | null> {
  const row = await deps.db.one<{ value: { previous: string | null; current: string } }>(`SELECT value FROM app_state WHERE key = 'visit'`);
  return row?.value.previous ?? null;
}

export async function includeGrantsDefault(deps: AppDeps): Promise<boolean> {
  const row = await deps.db.one<{ include_grants: boolean }>('SELECT include_grants FROM company_profiles ORDER BY created_at LIMIT 1');
  return row?.include_grants ?? false;
}

export function registerMetaRoutes(app: Hono, deps: AppDeps) {
  const { db, config } = deps;

  app.get('/api/health', async (c) => {
    await db.query('SELECT 1');
    return c.json({ ok: true, database: db.kind, time: new Date().toISOString() });
  });

  // Booleans only — secret values never leave the server.
  app.get('/api/meta', async (c) => {
    const reasons = await db.query('SELECT code, label, polarity FROM user_feedback_reasons ORDER BY sort_order');
    const samUsed = await db.one<{ requests: number }>(`SELECT requests FROM api_usage WHERE connector_id = 'sam' AND usage_date = current_date`);
    return c.json({
      configuration: {
        database: db.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : 'Embedded PGlite (local file)',
        samApiKey: !!config.samApiKey,
        anthropicApiKey: !!config.anthropicApiKey,
        anthropicModel: config.anthropicApiKey ? config.anthropicModel : null,
        cronSecret: !!config.cronSecret,
        appPassword: !!config.appPassword,
        schedulerEnabled: config.schedulerEnabled,
        samDailyRequestLimit: config.samDailyRequestLimit,
        samRequestsUsedToday: samUsed?.requests ?? 0,
        samDownloadDocuments: config.samDownloadDocuments,
      },
      feedbackReasons: reasons,
    });
  });

  /** Record a visit; returns the previous visit time used for "New since last visit". */
  app.post('/api/session/visit', async (c) => {
    const row = await db.one<{ value: { previous: string | null; current: string } }>(`SELECT value FROM app_state WHERE key = 'visit'`);
    const now = new Date().toISOString();
    let value = row?.value ?? { previous: null, current: now };
    // A new "visit" starts after 30 minutes of inactivity.
    if (row && Date.now() - new Date(row.value.current).getTime() > 30 * 60_000) value = { previous: row.value.current, current: now };
    else value = { previous: value.previous, current: now };
    await db.query(`INSERT INTO app_state (key, value) VALUES ('visit', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [json(value)]);
    return c.json(value);
  });

  app.get('/api/queues', async (c) => {
    const views = await db.query<{ slug: string; name: string; description: string; filters: Record<string, unknown>; sort: string; is_system: boolean }>(
      'SELECT slug, name, description, filters, sort, is_system FROM watchlists ORDER BY is_system DESC, sort_order, created_at',
    );
    const lastVisit = await getLastVisit(deps);
    const grants = await includeGrantsDefault(deps);
    const out = [];
    for (const v of views) {
      if (v.slug === 'grants' && !grants) continue;
      const f = OpportunityFilters.parse(v.filters);
      const q = buildOpportunityQuery(f, { lastVisit, includeGrantsDefault: grants });
      const row = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM opportunities o ${DECISION_JOIN} WHERE ${q.where}`, q.params);
      out.push({ ...v, count: row?.n ?? 0 });
    }
    return c.json(out);
  });

  app.post('/api/queues', async (c) => {
    const body = await c.req.json<{ name: string; filters: Record<string, unknown>; sort?: string }>();
    if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400);
    const f = OpportunityFilters.parse(body.filters ?? {});
    const row = await db.one('INSERT INTO watchlists (name, filters, sort, is_system) VALUES ($1,$2::jsonb,$3,false) RETURNING *', [body.name.trim().slice(0, 80), json(f), body.sort ?? 'best']);
    return c.json(row);
  });

  app.delete('/api/queues/:id', async (c) => {
    await db.query('DELETE FROM watchlists WHERE id::text = $1 AND NOT is_system', [c.req.param('id')]);
    return c.json({ ok: true });
  });

  /** Portable backup of everything the user created (profile, decisions, notes, tags, manual links, merges, model history). */
  app.get('/api/export/backup.json', async (c) => {
    const tables = [
      'company_profiles',
      'company_capabilities',
      'company_naics',
      'company_psc',
      'company_certifications',
      'company_contract_vehicles',
      'company_past_performance',
      'user_opportunity_decisions',
      'user_notes',
      'user_tags',
      'user_field_overrides',
      'merge_decisions',
      'watchlists',
      'preference_models',
      'preference_weights',
    ];
    const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), format: 'goi-backup-v1' };
    for (const t of tables) out[t] = await db.query(`SELECT * FROM ${t}`);
    out.custom_capabilities = await db.query('SELECT * FROM capabilities WHERE is_custom');
    out.manual_relationships = await db.query(`SELECT * FROM opportunity_relationships WHERE created_by = 'user' OR status <> 'suggested'`);
    out.opportunity_index = await db.query(
      `SELECT o.id, o.title, o.solicitation_number, o.primary_notice_id FROM opportunities o WHERE EXISTS (SELECT 1 FROM user_opportunity_decisions d WHERE d.opportunity_id = o.id) OR EXISTS (SELECT 1 FROM user_notes n WHERE n.opportunity_id = o.id)`,
    );
    c.header('Content-Disposition', `attachment; filename="goi-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json(out);
  });
}
