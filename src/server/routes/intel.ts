import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { connectorPriorities } from '../connectors/registry';
import { searchRowToRecord, usaspendingAdapter, usaspendingSearch } from '../connectors/usaspending';
import { emptyStats, ingestRecord } from '../pipeline/ingest';
import { decideRelationship, mergeOpportunities, undoMerge } from '../pipeline/merge';
import { loadCompanyContext } from '../scoring/profile';
import { FEATURE_GROUP_LABELS, featureGroup } from '../scoring/preference';
import { scoreMany } from '../scoring/run';
import { getLastVisit, includeGrantsDefault } from './meta';
import { retrainState, scheduleRetrain } from './opportunities';
import { buildOpportunityQuery, DECISION_JOIN, LIST_COLUMNS, OpportunityFilters } from './query';

export function registerIntelRoutes(app: Hono, deps: AppDeps) {
  const { db } = deps;

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  app.get('/api/dashboard', async (c) => {
    const lastVisit = await getLastVisit(deps);
    const grants = await includeGrantsDefault(deps);
    const count = async (filters: Record<string, unknown>) => {
      const q = buildOpportunityQuery(OpportunityFilters.parse(filters), { lastVisit, includeGrantsDefault: grants });
      return (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM opportunities o ${DECISION_JOIN} WHERE ${q.where}`, q.params))?.n ?? 0;
    };
    const kpis = {
      newSinceVisit: lastVisit ? await count({ newSinceVisit: true }) : await count({ changedWithinDays: 1 }),
      highMatches: await count({ minFit: 70, openOnly: true }),
      unreviewed: await count({ minFit: 40, decision: ['none'], openOnly: true }),
      due7: await count({ dueWithinDays: 7 }),
      due30: await count({ dueWithinDays: 30 }),
      forecasts: await count({ stage: ['forecast'] }),
      recompetes: await count({ recompete: true }),
      subcontracts: await count({ opportunityClass: ['subcontract'], openOnly: true }),
      recentlyChanged: await count({ changedWithinDays: 7 }),
      total: await count({}),
    };
    const coverage = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM coverage_signals WHERE status = 'open'`);
    const pipeline = await db.one<{ official: number; estimated: number; n: number; unknown: number }>(
      `SELECT COALESCE(sum(COALESCE(o.value_high, o.value_low)) FILTER (WHERE o.value_provenance = 'official'), 0) AS official,
              COALESCE(sum(COALESCE(o.value_high, o.value_low)) FILTER (WHERE o.value_provenance IN ('estimated','derived')), 0) AS estimated,
              count(*) FILTER (WHERE o.value_low IS NULL AND o.value_high IS NULL)::int AS unknown, count(*)::int AS n
       FROM opportunities o ${DECISION_JOIN} WHERE o.merged_into_id IS NULL AND d.decision IN ('strong_pursue','pursue','partner_sub','interested')`,
    );
    const q = buildOpportunityQuery(OpportunityFilters.parse({ openOnly: true, sort: 'preference' }), { lastVisit, includeGrantsDefault: grants });
    const top = await db.query(`SELECT ${LIST_COLUMNS} FROM opportunities o ${DECISION_JOIN} WHERE ${q.where} ORDER BY ${q.orderBy} LIMIT 30`, q.params);
    const changes = await db.query(
      `SELECT e.id, e.event_type, e.title, e.detected_at, e.occurred_at, o.id AS opportunity_id, o.title AS opportunity_title, o.fit_score
       FROM opportunity_events e JOIN opportunities o ON o.id = e.opportunity_id
       WHERE e.event_type NOT IN ('LIFECYCLE') AND o.merged_into_id IS NULL ORDER BY e.detected_at DESC LIMIT 25`,
    );
    const sources = await db.query(`SELECT id, name, health, health_message, last_success_at, last_attempted_at, source_type FROM source_connectors WHERE source_type <> 'engine' ORDER BY priority`);
    const model = await db.one('SELECT version, sample_count, stage, blend_alpha, created_at FROM preference_models WHERE is_active ORDER BY version DESC LIMIT 1');
    const company = await db.one<{ name: string | null; onboarding_completed_at: string | null; onboarding_step: number }>('SELECT name, onboarding_completed_at, onboarding_step FROM company_profiles ORDER BY created_at LIMIT 1');
    const caps = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM company_capabilities WHERE status = 'confirmed'`);
    return c.json({ kpis: { ...kpis, coverageGaps: coverage?.n ?? 0, pipeline }, top, changes, sources, model, company, confirmedCapabilities: caps?.n ?? 0, lastVisit });
  });

  app.get('/api/changes', async (c) => {
    const f = z
      .object({ type: z.string().optional(), days: z.coerce.number().int().min(1).max(3650).default(14), minFit: z.coerce.number().optional(), page: z.coerce.number().int().min(1).default(1) })
      .parse(c.req.query());
    // Base window (used for the per-type counts) and the list filter (base + type).
    const base = `e.detected_at >= now() - ($1::int * interval '1 day') AND o.merged_into_id IS NULL AND e.event_type <> 'LIFECYCLE' AND COALESCE(o.fit_score,0) >= $2`;
    const baseParams: unknown[] = [f.days, f.minFit ?? 0];
    const listWhere = f.type ? `${base} AND e.event_type = ANY($3::text[])` : base;
    const listParams = f.type ? [...baseParams, f.type.split(',')] : baseParams;
    const rows = await db.query(
      `SELECT e.*, o.title AS opportunity_title, o.stage, o.fit_score, o.preference_score, o.is_signal, sc.name AS connector_name FROM opportunity_events e JOIN opportunities o ON o.id = e.opportunity_id
       LEFT JOIN source_connectors sc ON sc.id = e.connector_id WHERE ${listWhere} ORDER BY e.detected_at DESC LIMIT 100 OFFSET ${(f.page - 1) * 100}`,
      listParams,
    );
    const counts = await db.query(`SELECT e.event_type, count(*)::int AS n FROM opportunity_events e JOIN opportunities o ON o.id = e.opportunity_id WHERE ${base} GROUP BY 1 ORDER BY 2 DESC`, baseParams);
    return c.json({ events: rows, counts });
  });

  // ---------------------------------------------------------------------------
  // Coverage gaps
  // ---------------------------------------------------------------------------
  app.get('/api/coverage', async (c) => {
    const status = c.req.query('status') ?? 'open';
    const type = c.req.query('type');
    const params: unknown[] = [status];
    let where = 'cs.status = $1';
    if (type) {
      params.push(type);
      where += ` AND cs.signal_type = $2`;
    }
    const signals = await db.query(
      `SELECT cs.*, o.title AS opportunity_title, o.fit_score, o.stage, o.department_name, o.subtier_name, o.response_deadline, o.value_low, o.value_high, o.value_provenance,
         a.piid, a.awardee_name, a.total_obligated
       FROM coverage_signals cs LEFT JOIN opportunities o ON o.id = cs.opportunity_id LEFT JOIN awards a ON a.id = cs.award_id
       WHERE ${where} ORDER BY CASE cs.severity WHEN 'important' THEN 0 WHEN 'notice' THEN 1 ELSE 2 END, o.fit_score DESC NULLS LAST, cs.last_detected_at DESC LIMIT 500`,
      params,
    );
    const counts = await db.query(`SELECT signal_type, status, count(*)::int AS n FROM coverage_signals GROUP BY 1, 2`);
    return c.json({ signals, counts });
  });

  app.put('/api/coverage/:id', async (c) => {
    const b = z.object({ status: z.enum(['open', 'dismissed']) }).parse(await readJson(c));
    await db.query('UPDATE coverage_signals SET status = $2 WHERE id::text = $1', [c.req.param('id'), b.status]);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Merge review
  // ---------------------------------------------------------------------------
  app.get('/api/merge/candidates', async (c) => {
    const status = c.req.query('status') ?? 'suggested';
    const rows = await db.query(
      `SELECT r.*, row_to_json(a) AS a, row_to_json(b) AS b FROM opportunity_relationships r
       JOIN LATERAL (SELECT id, title, stage, status, solicitation_number, primary_notice_id, department_name, subtier_name, office_name, naics_code, psc_code, set_aside_code, posted_at, response_deadline, value_low, value_high, value_provenance, connector_ids, fit_score, left(description, 600) AS description FROM opportunities WHERE id = r.from_opportunity_id) a ON true
       JOIN LATERAL (SELECT id, title, stage, status, solicitation_number, primary_notice_id, department_name, subtier_name, office_name, naics_code, psc_code, set_aside_code, posted_at, response_deadline, value_low, value_high, value_provenance, connector_ids, fit_score, left(description, 600) AS description FROM opportunities WHERE id = r.to_opportunity_id) b ON true
       WHERE r.status = $1 AND r.relationship_type <> 'merged' AND (SELECT merged_into_id FROM opportunities WHERE id = r.from_opportunity_id) IS NULL AND (SELECT merged_into_id FROM opportunities WHERE id = r.to_opportunity_id) IS NULL
       ORDER BY CASE r.relationship_type WHEN 'possible_duplicate' THEN 0 WHEN 'possible_same_procurement' THEN 1 WHEN 'forecast_of' THEN 2 ELSE 3 END, r.confidence DESC NULLS LAST LIMIT 200`,
      [status],
    );
    return c.json(rows);
  });

  app.post('/api/merge/action', async (c) => {
    const b = z
      .object({
        action: z.enum(['merge', 'keep_separate', 'link_related', 'mark_predecessor', 'mark_successor']),
        primaryId: z.string().uuid(),
        secondaryId: z.string().uuid(),
        relationshipId: z.string().uuid().nullable().optional(),
        note: z.string().max(1000).optional(),
      })
      .parse(await readJson(c));
    const priorities = await connectorPriorities(db);
    if (b.action === 'merge') {
      const id = await mergeOpportunities(db, b.primaryId, b.secondaryId, priorities, b.note).catch((err) => {
        throw new HttpProblem(409, err.message);
      });
      await scoreMany(db, [b.primaryId], 'merge');
      scheduleRetrain(deps, 'merge');
      return c.json({ mergeId: id });
    }
    await decideRelationship(db, b.action, b.primaryId, b.secondaryId, b.relationshipId ?? null, b.note);
    return c.json({ ok: true });
  });

  app.post('/api/merge/:id/undo', async (c) => {
    await undoMerge(db, c.req.param('id'), await connectorPriorities(db)).catch((err) => {
      throw new HttpProblem(409, err.message);
    });
    scheduleRetrain(deps, 'undo merge');
    return c.json({ ok: true });
  });

  app.get('/api/merge/history', async (c) => {
    const rows = await db.query(
      `SELECT m.id, m.action, m.primary_id, m.secondary_id, m.note, m.created_at, m.undone_at, p.title AS primary_title, s.title AS secondary_title
       FROM merge_decisions m JOIN opportunities p ON p.id = m.primary_id JOIN opportunities s ON s.id = m.secondary_id ORDER BY m.created_at DESC LIMIT 200`,
    );
    return c.json(rows);
  });

  // ---------------------------------------------------------------------------
  // Agencies & offices
  // ---------------------------------------------------------------------------
  app.get('/api/agencies', async (c) => {
    const rows = await db.query(
      `SELECT a.id, a.name, a.level, a.parent_id, p.name AS parent_name,
         (SELECT count(*)::int FROM opportunities o WHERE o.merged_into_id IS NULL AND (o.agency_id = a.id OR o.subagency_id = a.id)) AS opportunities,
         (SELECT count(*)::int FROM opportunities o WHERE o.merged_into_id IS NULL AND (o.agency_id = a.id OR o.subagency_id = a.id) AND COALESCE(o.fit_score,0) >= 50) AS relevant,
         (SELECT count(*)::int FROM opportunities o WHERE o.merged_into_id IS NULL AND (o.agency_id = a.id OR o.subagency_id = a.id) AND o.status = 'active' AND o.stage IN ('solicitation','combined_synopsis')) AS open_solicitations,
         (SELECT count(*)::int FROM user_opportunity_decisions d JOIN opportunities o ON o.id = d.opportunity_id WHERE d.is_current AND d.decision IN ('strong_pursue','pursue','partner_sub','interested') AND (o.agency_id = a.id OR o.subagency_id = a.id)) AS pursuits,
         (SELECT COALESCE(sum(COALESCE(aw.total_obligated, aw.dollars_obligated)),0) FROM awards aw WHERE aw.award_key NOT LIKE 'sam_notice:%' AND (CASE WHEN a.level = 'subtier' THEN aw.subtier_name ILIKE a.name ELSE aw.department_name ILIKE a.name END)) AS award_total
       FROM agencies a LEFT JOIN agencies p ON p.id = a.parent_id ORDER BY relevant DESC, opportunities DESC LIMIT 500`,
    );
    return c.json(rows);
  });

  app.get('/api/agencies/:id', async (c) => {
    const id = c.req.param('id');
    const agency = await db.one<any>('SELECT a.*, p.name AS parent_name FROM agencies a LEFT JOIN agencies p ON p.id = a.parent_id WHERE a.id::text = $1', [id]);
    if (!agency) throw new HttpProblem(404, 'Agency not found');
    const co = await loadCompanyContext(db);
    const nameMatch = agency.level === 'subtier' ? 'aw.subtier_name ILIKE $1' : 'aw.department_name ILIKE $1';
    const [children, offices, opportunities, awardsAgg, relevantSpend, topVendors, recentAwards, decisions, naicsSpend, expiring] = await Promise.all([
      db.query('SELECT id, name, level FROM agencies WHERE parent_id = $1 ORDER BY name', [agency.id]),
      db.query(
        `SELECT f.id, f.name, f.code, f.city, f.state, (SELECT count(*)::int FROM opportunities o WHERE o.office_id = f.id AND o.merged_into_id IS NULL) AS opportunities,
           (SELECT count(*)::int FROM opportunities o WHERE o.office_id = f.id AND o.merged_into_id IS NULL AND COALESCE(o.fit_score,0) >= 50) AS relevant
         FROM agency_offices f WHERE f.agency_id = $1 ORDER BY relevant DESC, opportunities DESC LIMIT 100`,
        [agency.id],
      ),
      db.query(`SELECT ${LIST_COLUMNS} FROM opportunities o ${DECISION_JOIN} WHERE o.merged_into_id IS NULL AND (o.agency_id = $1 OR o.subagency_id = $1) ORDER BY o.fit_score DESC NULLS LAST LIMIT 100`, [agency.id]),
      db.one(`SELECT count(*)::int AS n, COALESCE(sum(COALESCE(aw.total_obligated, aw.dollars_obligated)),0) AS total, avg(COALESCE(aw.base_and_all_options, aw.total_obligated)) AS avg_size FROM awards aw WHERE aw.award_key NOT LIKE 'sam_notice:%' AND ${nameMatch}`, [agency.name]),
      co.naics.length
        ? db.one(`SELECT count(*)::int AS n, COALESCE(sum(COALESCE(aw.total_obligated, aw.dollars_obligated)),0) AS total FROM awards aw WHERE aw.award_key NOT LIKE 'sam_notice:%' AND ${nameMatch} AND aw.naics_code = ANY($2::text[])`, [agency.name, co.naics])
        : Promise.resolve(null),
      db.query(
        `SELECT aw.awardee_name, aw.vendor_id, count(*)::int AS awards, sum(COALESCE(aw.total_obligated, aw.dollars_obligated, 0)) AS total FROM awards aw
         WHERE aw.award_key NOT LIKE 'sam_notice:%' AND ${nameMatch} AND aw.awardee_name IS NOT NULL GROUP BY 1, 2 ORDER BY total DESC NULLS LAST LIMIT 15`,
        [agency.name],
      ),
      db.query(`SELECT aw.* FROM awards aw WHERE aw.award_key NOT LIKE 'sam_notice:%' AND ${nameMatch} ORDER BY aw.date_signed DESC NULLS LAST LIMIT 25`, [agency.name]),
      db.query(`SELECT d.decision, count(*)::int AS n FROM user_opportunity_decisions d JOIN opportunities o ON o.id = d.opportunity_id WHERE d.is_current AND (o.agency_id = $1 OR o.subagency_id = $1) GROUP BY 1`, [agency.id]),
      db.query(`SELECT aw.naics_code, count(*)::int AS n, sum(COALESCE(aw.total_obligated, aw.dollars_obligated, 0)) AS total FROM awards aw WHERE aw.award_key NOT LIKE 'sam_notice:%' AND ${nameMatch} AND aw.naics_code IS NOT NULL GROUP BY 1 ORDER BY total DESC LIMIT 10`, [agency.name]),
      db.query(`SELECT aw.* FROM awards aw WHERE aw.award_key NOT LIKE 'sam_notice:%' AND ${nameMatch} AND aw.pop_current_end BETWEEN current_date AND current_date + interval '18 months' ORDER BY aw.pop_current_end LIMIT 25`, [agency.name]),
    ]);
    return c.json({ agency, children, offices, opportunities, awards: { aggregate: awardsAgg, relevantNaics: relevantSpend, naicsSpend, topVendors, recent: recentAwards, expiring }, decisions, companyNaics: co.naics });
  });

  app.post('/api/agencies/:id/enrich', async (c) => {
    const agency = await db.one<any>('SELECT * FROM agencies WHERE id::text = $1', [c.req.param('id')]);
    if (!agency) throw new HttpProblem(404, 'Agency not found');
    const co = await loadCompanyContext(db);
    const priorities = await connectorPriorities(db);
    const ictx = { db, connectorId: 'usaspending', connectorName: 'USAspending.gov', adapter: usaspendingAdapter, priorities, log: deps.log, dirty: new Set<string>(), stats: emptyStats() };
    const filter = agency.level === 'subtier' ? { awardingSubAgency: agency.name } : { awardingAgency: agency.name };
    const queries = co.naics.length ? co.naics.slice(0, 5).map((n) => ({ ...filter, naics: [n] })) : [filter];
    let n = 0;
    for (const q of queries) {
      const { results } = await usaspendingSearch({ http: deps.http }, q, { limit: 60 });
      for (const row of results) {
        await ingestRecord(ictx, searchRowToRecord(row));
        n++;
      }
    }
    return c.json({ awardsRetrieved: n });
  });

  app.get('/api/offices/:id', async (c) => {
    const office = await db.one<any>('SELECT f.*, a.name AS agency_name, a.id AS agency_id FROM agency_offices f LEFT JOIN agencies a ON a.id = f.agency_id WHERE f.id::text = $1', [c.req.param('id')]);
    if (!office) throw new HttpProblem(404, 'Office not found');
    const opportunities = await db.query(`SELECT ${LIST_COLUMNS} FROM opportunities o ${DECISION_JOIN} WHERE o.merged_into_id IS NULL AND o.office_id = $1 ORDER BY o.posted_at DESC NULLS LAST LIMIT 200`, [office.id]);
    const awards = await db.query(`SELECT * FROM awards WHERE award_key NOT LIKE 'sam_notice:%' AND office_name ILIKE $1 ORDER BY date_signed DESC NULLS LAST LIMIT 100`, [office.name]);
    return c.json({ office, opportunities, awards });
  });

  // ---------------------------------------------------------------------------
  // Vendors / incumbents
  // ---------------------------------------------------------------------------
  app.get('/api/vendors', async (c) => {
    const q = c.req.query('q');
    const params: unknown[] = [];
    let where = 'true';
    if (q) {
      params.push(`%${q}%`);
      where = `(v.name ILIKE $1 OR v.uei ILIKE $1 OR v.cage ILIKE $1)`;
    }
    const rows = await db.query(
      `SELECT v.*, x.awards, x.total, x.ending_soon, (SELECT count(*)::int FROM opportunity_vendors ov WHERE ov.vendor_id = v.id AND ov.role IN ('confirmed_incumbent','possible_incumbent')) AS incumbencies
       FROM vendors v LEFT JOIN LATERAL (SELECT count(*)::int AS awards, sum(COALESCE(a.total_obligated, a.dollars_obligated, 0)) AS total,
         count(*) FILTER (WHERE a.pop_current_end BETWEEN current_date AND current_date + interval '18 months')::int AS ending_soon
         FROM awards a WHERE a.vendor_id = v.id AND a.award_key NOT LIKE 'sam_notice:%') x ON true
       WHERE ${where} ORDER BY x.total DESC NULLS LAST LIMIT 300`,
      params,
    );
    return c.json(rows);
  });

  app.get('/api/vendors/:id', async (c) => {
    const vendor = await db.one<any>('SELECT * FROM vendors WHERE id::text = $1', [c.req.param('id')]);
    if (!vendor) throw new HttpProblem(404, 'Vendor not found');
    const [awards, agencies, naics, psc, roles] = await Promise.all([
      db.query(`SELECT a.*, sc.name AS connector_name FROM awards a LEFT JOIN source_connectors sc ON sc.id = a.connector_id WHERE a.vendor_id = $1 ORDER BY a.date_signed DESC NULLS LAST LIMIT 300`, [vendor.id]),
      db.query(`SELECT subtier_name, office_name, count(*)::int AS n, sum(COALESCE(total_obligated, dollars_obligated, 0)) AS total FROM awards WHERE vendor_id = $1 AND award_key NOT LIKE 'sam_notice:%' GROUP BY 1, 2 ORDER BY total DESC NULLS LAST LIMIT 30`, [vendor.id]),
      db.query(`SELECT naics_code, count(*)::int AS n, sum(COALESCE(total_obligated, dollars_obligated, 0)) AS total FROM awards WHERE vendor_id = $1 AND naics_code IS NOT NULL AND award_key NOT LIKE 'sam_notice:%' GROUP BY 1 ORDER BY total DESC LIMIT 15`, [vendor.id]),
      db.query(`SELECT psc_code, count(*)::int AS n, sum(COALESCE(total_obligated, dollars_obligated, 0)) AS total FROM awards WHERE vendor_id = $1 AND psc_code IS NOT NULL AND award_key NOT LIKE 'sam_notice:%' GROUP BY 1 ORDER BY total DESC LIMIT 15`, [vendor.id]),
      db.query(
        `SELECT ov.role, ov.confidence, ov.evidence, o.id, o.title, o.stage, o.status, o.fit_score, o.response_deadline, o.is_signal FROM opportunity_vendors ov JOIN opportunities o ON o.id = ov.opportunity_id
         WHERE ov.vendor_id = $1 AND o.merged_into_id IS NULL ORDER BY o.fit_score DESC NULLS LAST LIMIT 100`,
        [vendor.id],
      ),
    ]);
    return c.json({ vendor, awards, agencies, naics, psc, roles });
  });

  // ---------------------------------------------------------------------------
  // Preference learning
  // ---------------------------------------------------------------------------
  app.get('/api/preferences/model', async (c) => {
    const models = await db.query<any>('SELECT id, version, sample_count, stage, blend_alpha, bias, metrics, trigger, is_active, created_at FROM preference_models ORDER BY version DESC LIMIT 50');
    const active = models.find((m) => m.is_active) ?? null;
    const previous = active ? models.find((m) => m.version === active.version - 1) ?? null : null;
    const weights = active ? await db.query<{ feature: string; weight: number; support: number }>('SELECT feature, weight, support FROM preference_weights WHERE model_id = $1 ORDER BY abs(weight) DESC LIMIT 400', [active.id]) : [];
    const prevWeights = previous ? new Map((await db.query<{ feature: string; weight: number }>('SELECT feature, weight FROM preference_weights WHERE model_id = $1', [previous.id])).map((w) => [w.feature, Number(w.weight)])) : new Map<string, number>();
    const decorated = weights.map((w) => ({ ...w, weight: Number(w.weight), group: FEATURE_GROUP_LABELS[featureGroup(w.feature).split(':')[0]] ?? featureGroup(w.feature), previous: prevWeights.get(w.feature) ?? 0 }));
    const changes = decorated
      .map((w) => ({ ...w, delta: w.weight - w.previous }))
      .filter((w) => Math.abs(w.delta) > 0.02)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 20);
    const decisionCounts = await db.query(`SELECT decision, count(*)::int AS n FROM user_opportunity_decisions WHERE is_current GROUP BY 1`);
    const reasonCounts = await db.query(
      `SELECT r.code, r.label, r.polarity, count(*)::int AS n
       FROM user_opportunity_decisions d CROSS JOIN LATERAL unnest(d.reasons) AS u(reason_code) JOIN user_feedback_reasons r ON r.code = u.reason_code
       WHERE d.is_current GROUP BY 1, 2, 3 ORDER BY n DESC`,
    );
    const movers = await db.query(
      `SELECT DISTINCT ON (h.opportunity_id) h.opportunity_id, o.title, h.fit_score, h.preference_score, (h.preference_score - h.fit_score) AS lift
       FROM score_history h JOIN opportunities o ON o.id = h.opportunity_id WHERE h.model_version = $1 AND o.merged_into_id IS NULL ORDER BY h.opportunity_id, h.computed_at DESC`,
      [active?.version ?? -1],
    );
    const topMovers = (movers as any[]).sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift)).slice(0, 15);
    return c.json({
      active,
      previous,
      models,
      positive: decorated.filter((w) => w.weight > 0).slice(0, 25),
      negative: decorated.filter((w) => w.weight < 0).slice(0, 25),
      changes,
      decisionCounts,
      reasonCounts,
      topMovers,
      state: retrainState(),
    });
  });

  app.post('/api/preferences/retrain', async (c) => {
    scheduleRetrain(deps, 'manual retrain', 10);
    return c.json({ scheduled: true });
  });
}
