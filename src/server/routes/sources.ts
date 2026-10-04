import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpProblem, readJson, safeEqual, type AppDeps } from '../app';
import { json } from '../db';
import { getAdapter, builtinAdapter } from '../connectors/registry';
import { focusFor, postProcess, runAllSources, runConnector, startExclusive, syncStatus } from '../pipeline/sync';
import { runDueWork } from '../pipeline/scheduler';
import { assertSafeUrlSyntax, UnsafeUrlError } from '../lib/urlSafety';

const FeedSchema = z.object({
  name: z.string().min(2).max(120),
  url: z.string().url(),
  format: z.enum(['rss', 'atom', 'json', 'csv']),
  opportunityClass: z.enum(['prime', 'subcontract', 'grant']).default('prime'),
  stage: z.string().max(40).optional(),
  jurisdiction: z.string().max(200).optional(),
  jurisdictionLevel: z.enum(['federal', 'state', 'county', 'municipal', 'authority', 'university', 'other']).optional(),
  itemsPath: z.string().max(200).optional(),
  fields: z.record(z.string(), z.string().max(200)).optional(),
  scheduleMinutes: z.number().int().min(60).max(60 * 24 * 30).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

export function registerSourceRoutes(app: Hono, deps: AppDeps) {
  const { db, config } = deps;

  app.get('/api/sources', async (c) => {
    const rows = await db.query<any>(
      `SELECT sc.*, r.status AS last_status, r.started_at AS last_run_started, r.finished_at AS last_run_finished, r.duration_ms AS last_duration_ms, r.records_retrieved AS last_retrieved,
         r.records_created AS last_created, r.records_updated AS last_updated, r.records_unchanged AS last_unchanged, r.records_failed AS last_failed, r.message AS last_message, r.mode AS last_mode,
         (SELECT count(*)::int FROM source_records s WHERE s.connector_id = sc.id) AS stored_records,
         (SELECT max(finished_at) FROM sync_runs x WHERE x.connector_id = sc.id AND x.mode = 'reconcile' AND x.status IN ('success','partial_success')) AS last_reconciled_at
       FROM source_connectors sc LEFT JOIN sync_runs r ON r.id = sc.last_run_id ORDER BY CASE WHEN sc.source_type = 'engine' THEN 1 ELSE 0 END, sc.priority, sc.name`,
    );
    const samUsage = await db.one<{ requests: number }>(`SELECT requests FROM api_usage WHERE connector_id = 'sam' AND usage_date = current_date`);
    const out = rows.map((r) => {
      const a = builtinAdapter(r.id);
      return {
        ...r,
        description: a?.meta.description ?? r.notes,
        supportsReconcile: !!a?.fetchReconcile,
        reconcileScheduleMinutes: a?.meta.reconcileScheduleMinutes ?? null,
        configured: a ? a.isConfigured(config).configured : true,
        configuredReason: a ? a.isConfigured(config).reason ?? null : null,
      };
    });
    return c.json({ sources: out, budget: { sam: { limit: config.samDailyRequestLimit, used: samUsage?.requests ?? 0 } }, status: syncStatus(), schedulerEnabled: config.schedulerEnabled });
  });

  app.put('/api/sources/:id', async (c) => {
    const b = z.object({ enabled: z.boolean().optional(), scheduleMinutes: z.number().int().min(15).max(60 * 24 * 30).nullable().optional(), config: z.record(z.string(), z.unknown()).optional() }).parse(await readJson(c));
    const id = c.req.param('id');
    const row = await db.one<any>('SELECT * FROM source_connectors WHERE id = $1', [id]);
    if (!row) throw new HttpProblem(404, 'Source not found');
    await db.query(
      `UPDATE source_connectors SET enabled = COALESCE($2, enabled), schedule_minutes = CASE WHEN $3 THEN $4 ELSE schedule_minutes END, config = COALESCE($5::jsonb, config),
         health = CASE WHEN COALESCE($2, enabled) = false THEN 'disabled' WHEN health = 'disabled' THEN 'unknown' ELSE health END, updated_at = now() WHERE id = $1`,
      [id, b.enabled ?? null, b.scheduleMinutes !== undefined, b.scheduleMinutes ?? null, b.config ? json({ ...row.config, ...b.config }) : null],
    );
    return c.json({ ok: true });
  });

  app.post('/api/sources/:id/test', async (c) => {
    const id = c.req.param('id');
    const adapter = await getAdapter(db, id);
    if (!adapter) throw new HttpProblem(404, 'Source not found');
    const row = await db.one<any>('SELECT config FROM source_connectors WHERE id = $1', [id]);
    const result = await adapter.testConnection({ db, http: deps.http, config, log: deps.log, budget: deps.budget, settings: row?.config ?? {}, focus: await focusFor(db), shouldStop: () => false, params: {} });
    await db.query('UPDATE source_connectors SET health = $2, health_message = $3, updated_at = now() WHERE id = $1', [id, result.status, result.message]);
    return c.json(result);
  });

  app.post('/api/sources/:id/sync', async (c) => {
    const id = c.req.param('id');
    const b = z.object({ mode: z.enum(['incremental', 'reconcile']).default('incremental'), params: z.record(z.string(), z.unknown()).optional() }).parse(await readJson(c).catch(() => ({})));
    if (!(await getAdapter(db, id))) throw new HttpProblem(404, 'Source not found');
    const r = startExclusive(
      `${id} ${b.mode}`,
      async () => {
        const res = await runConnector(deps, id, { mode: b.mode, triggeredBy: 'manual', params: b.params });
        if (b.mode === 'reconcile' && res.status !== 'failed')
          await db.query(`INSERT INTO app_state (key, value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [`reconcile:${id}`, json({ at: new Date().toISOString(), runId: res.runId })]);
        await postProcess(deps, { dirty: new Set(res.dirty), triggeredBy: 'manual', runRecompete: id === 'usaspending' || res.dirty.length > 0 });
      },
      deps.log,
    );
    if (!r.started) throw new HttpProblem(409, `A sync is already running (${r.label}).`);
    return c.json({ started: true });
  });

  app.post('/api/sync/all', async (c) => {
    const b = z.object({ mode: z.enum(['incremental', 'reconcile']).default('incremental') }).parse(await readJson(c).catch(() => ({})));
    const r = startExclusive(`Refresh all sources${b.mode === 'reconcile' ? ' (reconcile)' : ''}`, () => runAllSources(deps, { triggeredBy: 'manual', mode: b.mode }), deps.log);
    if (!r.started) throw new HttpProblem(409, `A sync is already running (${r.label}).`);
    return c.json({ started: true });
  });

  app.get('/api/sync/status', async (c) => {
    const running = await db.query(
      `SELECT r.id, r.connector_id, sc.name, r.mode, r.started_at, r.records_retrieved, r.records_created, r.records_updated, r.records_unchanged, r.records_failed
       FROM sync_runs r JOIN source_connectors sc ON sc.id = r.connector_id WHERE r.status = 'running' ORDER BY r.started_at DESC`,
    );
    return c.json({ ...syncStatus(), runs: running });
  });

  app.get('/api/sync/runs', async (c) => {
    const connector = c.req.query('connector');
    const rows = await db.query(
      `SELECT r.*, sc.name AS connector_name, (SELECT count(*)::int FROM sync_errors e WHERE e.sync_run_id = r.id) AS error_count
       FROM sync_runs r JOIN source_connectors sc ON sc.id = r.connector_id ${connector ? 'WHERE r.connector_id = $1' : ''} ORDER BY r.created_at DESC LIMIT 150`,
      connector ? [connector] : [],
    );
    return c.json(rows);
  });

  app.get('/api/sync/runs/:id', async (c) => {
    const run = await db.one('SELECT r.*, sc.name AS connector_name FROM sync_runs r JOIN source_connectors sc ON sc.id = r.connector_id WHERE r.id::text = $1', [c.req.param('id')]);
    if (!run) throw new HttpProblem(404, 'Run not found');
    const errors = await db.query('SELECT * FROM sync_errors WHERE sync_run_id::text = $1 ORDER BY created_at LIMIT 500', [c.req.param('id')]);
    return c.json({ run, errors });
  });

  // Custom public feed connectors (Tier 8)
  app.post('/api/sources', async (c) => {
    const b = FeedSchema.parse(await readJson(c));
    try {
      assertSafeUrlSyntax(b.url);
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new HttpProblem(400, `Feed URL rejected: ${err.message}`);
      throw err;
    }
    const id = `feed_${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}_${Date.now().toString(36)}`;
    await db.query(
      `INSERT INTO source_connectors (id, name, source_type, base_url, access_method, enabled, auth_required, priority, schedule_minutes, config, notes, is_custom, health)
       VALUES ($1,$2,'feed',$3,'feed',true,false,60,$4,$5::jsonb,$6,true,'unknown')`,
      [id, b.name, b.url, b.scheduleMinutes ?? 24 * 60, json({ url: b.url, format: b.format, opportunityClass: b.opportunityClass, stage: b.stage, jurisdiction: b.jurisdiction, jurisdictionLevel: b.jurisdictionLevel, itemsPath: b.itemsPath, fields: b.fields }), b.notes ?? null],
    );
    return c.json({ id });
  });

  app.delete('/api/sources/:id', async (c) => {
    const id = c.req.param('id');
    const row = await db.one<{ is_custom: boolean }>('SELECT is_custom FROM source_connectors WHERE id = $1', [id]);
    if (!row?.is_custom) throw new HttpProblem(400, 'Built-in sources cannot be removed (disable them instead).');
    const records = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM source_records WHERE connector_id = $1', [id]);
    if (records?.n) {
      await db.query(`UPDATE source_connectors SET enabled = false, health = 'disabled' WHERE id = $1`, [id]);
      return c.json({ ok: true, message: `Disabled instead of deleted: ${records.n} stored records from this source are preserved.` });
    }
    await db.query('DELETE FROM sync_runs WHERE connector_id = $1', [id]);
    await db.query('DELETE FROM source_connectors WHERE id = $1', [id]);
    return c.json({ ok: true });
  });

  // External scheduler entry point (GitHub Actions, Render cron, Supabase pg_cron + http, etc.)
  app.post('/api/cron/sync', async (c) => {
    if (!config.cronSecret) throw new HttpProblem(503, 'CRON_SECRET is not configured on the server.');
    const auth = c.req.header('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token || !safeEqual(token, config.cronSecret)) throw new HttpProblem(401, 'Invalid cron secret.');
    const mode = c.req.query('mode');
    if (mode === 'all') {
      const r = startExclusive('Cron: refresh all sources', () => runAllSources(deps, { triggeredBy: 'cron' }), deps.log);
      return c.json(r);
    }
    return c.json(await runDueWork(deps, 'cron'));
  });
}
