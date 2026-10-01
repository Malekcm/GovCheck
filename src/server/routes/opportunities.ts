import type { Hono } from 'hono';
import { z } from 'zod';
import { DECISIONS, PROVENANCE_RANK, type Provenance } from '../../shared/domain';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { json } from '../db';
import { analyzeOpportunity, createAiProvider } from '../ai/analyze';
import { connectorPriorities } from '../connectors/registry';
import { formatRange } from '../lib/money';
import { chooseValue, recomputeOpportunity } from '../pipeline/canonical';
import { recordEvent } from '../pipeline/events';
import { upsertRelationship } from '../pipeline/resolve';
import { refreshOpportunity } from '../pipeline/sync';
import { contributions, FEATURE_GROUP_LABELS, featureGroup, loadActiveModel } from '../scoring/preference';
import { retrainAndRescore } from '../scoring/run';
import { getLastVisit, includeGrantsDefault } from './meta';
import { buildOpportunityQuery, DECISION_JOIN, LIST_COLUMNS, OpportunityFilters } from './query';

// Debounced, single-flight preference retraining after decisions change.
let retrainTimer: NodeJS.Timeout | null = null;
let retraining: Promise<unknown> | null = null;
let retrainPending = false;
export function scheduleRetrain(deps: AppDeps, trigger: string, delayMs = 1500) {
  if (retrainTimer) clearTimeout(retrainTimer);
  retrainTimer = setTimeout(() => {
    retrainTimer = null;
    if (retraining) {
      retrainPending = true;
      return;
    }
    retraining = retrainAndRescore(deps.db, trigger)
      .catch((err) => deps.log.error('Preference retraining failed', err))
      .finally(() => {
        retraining = null;
        if (retrainPending) {
          retrainPending = false;
          scheduleRetrain(deps, 'queued decisions', 100);
        }
      });
  }, delayMs);
}
export function retrainState() {
  return { pending: !!retrainTimer || retrainPending, running: !!retraining };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerOpportunityRoutes(app: Hono, deps: AppDeps) {
  const { db } = deps;

  const parseFilters = async (query: Record<string, string>) => {
    const f = OpportunityFilters.parse(query);
    return { f, q: buildOpportunityQuery(f, { lastVisit: await getLastVisit(deps), includeGrantsDefault: await includeGrantsDefault(deps) }) };
  };

  app.get('/api/opportunities', async (c) => {
    const { f, q } = await parseFilters(c.req.query());
    const pageSize = f.pageSize ?? 50;
    const page = f.page ?? 1;
    const total = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM opportunities o ${DECISION_JOIN} WHERE ${q.where}`, q.params);
    const items = await db.query(
      `SELECT ${LIST_COLUMNS}, (SELECT count(*)::int FROM opportunity_events e WHERE e.opportunity_id = o.id AND e.detected_at > now() - interval '7 days' AND e.event_type NOT IN ('LIFECYCLE','NEW_OPPORTUNITY')) AS recent_changes
       FROM opportunities o ${DECISION_JOIN} WHERE ${q.where} ORDER BY ${q.orderBy} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      q.params,
    );
    return c.json({ items, total: total?.n ?? 0, page, pageSize });
  });

  app.get('/api/opportunities/export.csv', async (c) => {
    const { q } = await parseFilters(c.req.query());
    const rows = await db.query<any>(`SELECT ${LIST_COLUMNS}, o.primary_url FROM opportunities o ${DECISION_JOIN} WHERE ${q.where} ORDER BY ${q.orderBy} LIMIT 20000`, q.params);
    const cols: [string, (r: any) => unknown][] = [
      ['Fit score', (r) => r.fit_score],
      ['Preference score', (r) => r.preference_score],
      ['Eligibility', (r) => r.eligibility_status],
      ['Decision', (r) => r.decision],
      ['Title', (r) => r.title],
      ['Class', (r) => r.opportunity_class],
      ['Stage', (r) => r.stage],
      ['Intelligence signal (not a solicitation)', (r) => (r.is_signal ? 'YES' : '')],
      ['Status', (r) => r.status],
      ['Solicitation number', (r) => r.solicitation_number],
      ['Department', (r) => r.department_name],
      ['Sub-agency', (r) => r.subtier_name],
      ['Office', (r) => r.office_name],
      ['NAICS', (r) => r.naics_code],
      ['PSC', (r) => r.psc_code],
      ['Set-aside', (r) => r.set_aside ?? r.set_aside_code],
      ['Value', (r) => formatRange(r.value_low, r.value_high)],
      ['Value represents', (r) => r.value_label],
      ['Value provenance', (r) => r.value_provenance],
      ['Response deadline', (r) => r.response_deadline],
      ['Posted', (r) => r.posted_at],
      ['Place of performance', (r) => [r.place_city, r.place_state].filter(Boolean).join(', ')],
      ['Incumbent', (r) => r.incumbent_name],
      ['Sources', (r) => r.connector_ids],
      ['Data completeness %', (r) => r.data_completeness],
      ['Last changed', (r) => r.last_changed_at],
      ['Source URL', (r) => r.primary_url],
      ['Profile ID', (r) => r.id],
    ];
    const lines = [cols.map(([h]) => csvCell(h)).join(','), ...rows.map((r) => cols.map(([, f]) => csvCell(f(r))).join(','))];
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="opportunities-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(`\ufeff${lines.join('\r\n')}`);
  });

  // ---------------------------------------------------------------------------
  // The intelligence dossier
  // ---------------------------------------------------------------------------
  app.get('/api/opportunities/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpProblem(404, 'Not found');
    const opp = await db.one<any>('SELECT * FROM opportunities WHERE id = $1', [id]);
    if (!opp) throw new HttpProblem(404, 'Opportunity not found');
    if (opp.merged_into_id) return c.json({ redirect: opp.merged_into_id, mergedInto: opp.merged_into_id });

    const priorities = await connectorPriorities(db);
    const [
      sources,
      fieldValues,
      identifiers,
      dates,
      financials,
      contacts,
      locations,
      documents,
      requirements,
      awards,
      vendors,
      relationships,
      events,
      score,
      components,
      explanations,
      decisions,
      notes,
      tags,
      overrides,
      aiBrief,
      aiAnalysis,
      scoreHistory,
    ] = await Promise.all([
      db.query(
        `SELECT os.role, os.link_method, os.confidence, os.evidence, os.linked_at, sr.id AS source_record_id, sr.connector_id, sc.name AS connector_name, sc.access_method,
           sr.source_record_id AS external_id, sr.record_kind, sr.retrieved_at, sr.first_seen_at, sr.last_seen_at, sr.last_changed_at, sr.version_count, sr.seen_status,
           sr.source_url, sr.parser_version, sr.content_hash, sr.normalized->'data'->>'stage' AS stage, sr.normalized->'data'->>'noticeType' AS notice_type, sr.normalized->'data'->>'title' AS title
         FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id JOIN source_connectors sc ON sc.id = sr.connector_id
         WHERE os.opportunity_id = $1 ORDER BY sr.first_seen_at`,
        [id],
      ),
      db.query<any>(
        `SELECT fv.id, fv.field, fv.value, fv.value_text, fv.provenance, fv.connector_id, fv.source_record_id, fv.basis, fv.confidence, fv.observed_at, fv.is_current, fv.superseded_at,
           sr.normalized->'data'->>'stage' AS src_stage, sc.name AS connector_name
         FROM opportunity_field_values fv LEFT JOIN source_records sr ON sr.id = fv.source_record_id LEFT JOIN source_connectors sc ON sc.id = fv.connector_id
         WHERE fv.opportunity_id = $1 ORDER BY fv.field, fv.observed_at DESC`,
        [id],
      ),
      db.query('SELECT id_type, value, source_record_id, created_at FROM opportunity_identifiers WHERE opportunity_id = $1 ORDER BY id_type', [id]),
      db.query(`SELECT d.*, sc.name AS connector_name FROM opportunity_dates d LEFT JOIN source_connectors sc ON sc.id = d.connector_id WHERE d.opportunity_id = $1 AND d.is_current ORDER BY d.date_value NULLS LAST`, [id]),
      db.query(
        `SELECT f.*, sc.name AS connector_name, a.piid, a.awardee_name FROM opportunity_financials f LEFT JOIN source_connectors sc ON sc.id = split_part(f.connector_id, ':', 1)
         LEFT JOIN awards a ON a.id = f.award_id WHERE f.opportunity_id = $1 AND f.is_current ORDER BY f.observed_at`,
        [id],
      ),
      db.query(
        `SELECT oc.role, oc.provenance, oc.connector_id, oc.first_seen_at, oc.last_seen_at, c.full_name, c.title, c.email, c.phone, c.fax, c.organization, sc.name AS connector_name
         FROM opportunity_contacts oc JOIN contacts c ON c.id = oc.contact_id LEFT JOIN source_connectors sc ON sc.id = oc.connector_id WHERE oc.opportunity_id = $1 ORDER BY oc.role`,
        [id],
      ),
      db.query('SELECT * FROM opportunity_locations WHERE opportunity_id = $1', [id]),
      db.query(
        `SELECT d.id, d.url, d.filename, d.doc_type, d.mime_type, d.size_bytes, d.posted_at, d.version, d.changed_since_previous, d.retrieval_status, d.text_status, d.page_count,
           d.error_message, d.retrieved_at, d.first_seen_at, d.connector_id, sc.name AS connector_name, length(d.text_content) AS text_length, left(d.text_content, 600) AS excerpt
         FROM opportunity_documents d LEFT JOIN source_connectors sc ON sc.id = d.connector_id WHERE d.opportunity_id = $1 ORDER BY d.posted_at NULLS LAST, d.first_seen_at`,
        [id],
      ),
      db.query(
        `SELECT r.id, r.category, r.text, r.provenance, r.page, r.section, r.evidence_quote, r.created_at, d.filename AS document_name, d.url AS document_url
         FROM opportunity_requirements r LEFT JOIN opportunity_documents d ON d.id = r.document_id WHERE r.opportunity_id = $1 AND r.is_current ORDER BY r.category, r.created_at`,
        [id],
      ),
      db.query(
        `SELECT oa.relationship, oa.confidence, oa.confidence_score, oa.method, oa.evidence, oa.status, a.*, sc.name AS connector_name, v.id AS vendor_id, v.cage AS vendor_cage
         FROM opportunity_awards oa JOIN awards a ON a.id = oa.award_id LEFT JOIN source_connectors sc ON sc.id = a.connector_id LEFT JOIN vendors v ON v.id = a.vendor_id
         WHERE oa.opportunity_id = $1 ORDER BY CASE oa.relationship WHEN 'award_of' THEN 0 WHEN 'incumbent' THEN 1 WHEN 'possible_incumbent' THEN 2 WHEN 'predecessor' THEN 3 ELSE 4 END, oa.confidence_score DESC NULLS LAST`,
        [id],
      ),
      db.query(`SELECT ov.role, ov.confidence, ov.evidence, v.* FROM opportunity_vendors ov JOIN vendors v ON v.id = ov.vendor_id WHERE ov.opportunity_id = $1`, [id]),
      db.query(
        `SELECT r.*, CASE WHEN r.from_opportunity_id = $1 THEN r.to_opportunity_id ELSE r.from_opportunity_id END AS other_id,
           o.title AS other_title, o.stage AS other_stage, o.status AS other_status, o.solicitation_number AS other_solicitation_number, o.posted_at AS other_posted_at, o.is_signal AS other_is_signal,
           (r.from_opportunity_id = $1) AS outgoing
         FROM opportunity_relationships r JOIN opportunities o ON o.id = CASE WHEN r.from_opportunity_id = $1 THEN r.to_opportunity_id ELSE r.from_opportunity_id END
         WHERE (r.from_opportunity_id = $1 OR r.to_opportunity_id = $1) AND r.status <> 'rejected' AND o.merged_into_id IS NULL ORDER BY r.confidence DESC NULLS LAST`,
        [id],
      ),
      db.query(`SELECT e.*, sc.name AS connector_name FROM opportunity_events e LEFT JOIN source_connectors sc ON sc.id = e.connector_id WHERE e.opportunity_id = $1 ORDER BY COALESCE(e.occurred_at, e.detected_at) DESC, e.detected_at DESC LIMIT 400`, [id]),
      db.one('SELECT * FROM match_scores WHERE opportunity_id = $1', [id]),
      db.query('SELECT * FROM match_score_components WHERE opportunity_id = $1', [id]),
      db.query('SELECT kind, component, text, severity, detail FROM match_explanations WHERE opportunity_id = $1', [id]),
      db.query('SELECT * FROM user_opportunity_decisions WHERE opportunity_id = $1 ORDER BY decided_at DESC', [id]),
      db.query('SELECT * FROM user_notes WHERE opportunity_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [id]),
      db.query('SELECT tag FROM user_tags WHERE opportunity_id = $1 ORDER BY tag', [id]),
      db.query('SELECT * FROM user_field_overrides WHERE opportunity_id = $1', [id]),
      db.one<{ value: any }>('SELECT value FROM app_state WHERE key = $1', [`ai_brief:${id}`]),
      db.one('SELECT id, provider, model, status, error_message, input_tokens, output_tokens, created_at FROM ai_analyses WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1', [id]),
      db.query('SELECT fit_score, preference_score, model_version, reason, computed_at FROM score_history WHERE opportunity_id = $1 ORDER BY computed_at DESC LIMIT 30', [id]),
    ]);

    // Field provenance: all current values per field, the preferred one flagged, conflicts highlighted.
    const current = fieldValues.filter((f: any) => f.is_current);
    const byField = new Map<string, any[]>();
    for (const f of current) byField.set(f.field, [...(byField.get(f.field) ?? []), f]);
    for (const o of overrides as any[]) byField.set(o.field, [...(byField.get(o.field) ?? []), { id: `override:${o.field}`, field: o.field, value: o.value, value_text: String(o.value), provenance: 'user_entered', connector_id: 'user', connector_name: 'You', observed_at: o.created_at, basis: o.note }]);
    const provenance = [...byField.entries()].map(([field, values]) => {
      const preferred = chooseValue(values as any, field, priorities);
      const distinct = new Set(values.map((v: any) => JSON.stringify(v.value)));
      return {
        field,
        preferredId: preferred?.id ?? null,
        conflict: distinct.size > 1 && values.filter((v: any) => v.provenance === 'official').length > 1,
        values: values.sort((a: any, b: any) => PROVENANCE_RANK[a.provenance as Provenance] - PROVENANCE_RANK[b.provenance as Provenance]),
      };
    });
    const history = fieldValues.filter((f: any) => !f.is_current);

    // Personalized score explanation
    const model = await loadActiveModel(db);
    const features = (explanations as any[]).find((e) => e.kind === 'features')?.detail?.features ?? {};
    const prefContribs = model.version ? contributions(model, features, 8).map((x) => ({ ...x, group: FEATURE_GROUP_LABELS[featureGroup(x.feature).split(':')[0]] ?? featureGroup(x.feature) })) : [];

    // Agency context (local accumulated data)
    const agencyStats = opp.subagency_id || opp.agency_id
      ? await db.one(
          `SELECT (SELECT count(*)::int FROM opportunities WHERE merged_into_id IS NULL AND (subagency_id = $1 OR ($1 IS NULL AND agency_id = $2))) AS opportunities,
             (SELECT count(*)::int FROM opportunities WHERE merged_into_id IS NULL AND office_id = $3) AS office_opportunities,
             (SELECT COALESCE(sum(COALESCE(a.total_obligated, a.dollars_obligated)),0) FROM awards a WHERE a.award_key NOT LIKE 'sam_notice:%' AND a.subtier_name ILIKE $4 AND ($5::text IS NULL OR a.naics_code = $5)) AS naics_award_total,
             (SELECT count(*)::int FROM awards a WHERE a.award_key NOT LIKE 'sam_notice:%' AND a.subtier_name ILIKE $4 AND ($5::text IS NULL OR a.naics_code = $5)) AS naics_award_count`,
          [opp.subagency_id, opp.agency_id, opp.office_id, opp.subtier_name ?? opp.department_name ?? '', opp.naics_code],
        )
      : null;
    const topVendors = opp.subtier_name
      ? await db.query(
          `SELECT a.awardee_name, a.vendor_id, count(*)::int AS awards, sum(COALESCE(a.total_obligated, a.dollars_obligated, 0)) AS total FROM awards a
           WHERE a.award_key NOT LIKE 'sam_notice:%' AND a.subtier_name ILIKE $1 AND ($2::text IS NULL OR a.naics_code = $2) AND a.awardee_name IS NOT NULL
           GROUP BY a.awardee_name, a.vendor_id ORDER BY total DESC NULLS LAST LIMIT 8`,
          [opp.subtier_name, opp.naics_code],
        )
      : [];

    return c.json({
      opportunity: opp,
      sources,
      provenance,
      fieldHistory: history.slice(0, 300),
      identifiers,
      dates,
      financials,
      contacts,
      locations,
      documents,
      requirements,
      awards,
      vendors,
      relationships,
      events,
      score,
      components,
      explanations,
      decisions,
      currentDecision: (decisions as any[]).find((d) => d.is_current) ?? null,
      notes,
      tags: (tags as any[]).map((t) => t.tag),
      overrides,
      aiBrief: aiBrief?.value ?? null,
      aiAnalysis,
      aiAvailable: !!deps.config.anthropicApiKey,
      scoreHistory,
      preference: { model: { version: model.version, stage: model.stage, alpha: model.alpha, sampleCount: model.sampleCount }, contributions: prefContribs },
      agencyStats,
      topVendors,
    });
  });

  // ---------------------------------------------------------------------------
  // User data (never touched by sync)
  // ---------------------------------------------------------------------------
  const exists = async (id: string) => {
    const o = await db.one<{ id: string }>('SELECT id FROM opportunities WHERE id::text = $1', [id]);
    if (!o) throw new HttpProblem(404, 'Opportunity not found');
    return o.id;
  };

  app.post('/api/opportunities/:id/decision', async (c) => {
    const id = await exists(c.req.param('id'));
    const b = z.object({ decision: z.enum(DECISIONS), reasons: z.array(z.string().max(60)).max(30).default([]), explanation: z.string().max(5000).nullable().optional() }).parse(await readJson(c));
    const feat = await db.one<{ detail: any }>(`SELECT detail FROM match_explanations WHERE opportunity_id = $1 AND kind = 'features'`, [id]);
    const row = await db.tx(async (tx) => {
      await tx.query('UPDATE user_opportunity_decisions SET is_current = false WHERE opportunity_id = $1 AND is_current', [id]);
      return tx.one(
        `INSERT INTO user_opportunity_decisions (opportunity_id, decision, reasons, explanation, is_current, feature_snapshot) VALUES ($1,$2,$3::text[],$4,true,$5::jsonb) RETURNING *`,
        [id, b.decision, b.reasons, b.explanation ?? null, json(feat?.detail?.features ?? null)],
      );
    });
    scheduleRetrain(deps, `decision: ${b.decision}`);
    return c.json(row);
  });

  /** Explicit user deletion of the current decision (history is kept). */
  app.delete('/api/opportunities/:id/decision', async (c) => {
    const id = await exists(c.req.param('id'));
    await db.query('UPDATE user_opportunity_decisions SET is_current = false WHERE opportunity_id = $1 AND is_current', [id]);
    scheduleRetrain(deps, 'decision cleared');
    return c.json({ ok: true });
  });

  app.post('/api/opportunities/:id/notes', async (c) => {
    const id = await exists(c.req.param('id'));
    const b = z.object({ body: z.string().min(1).max(20000) }).parse(await readJson(c));
    return c.json(await db.one('INSERT INTO user_notes (opportunity_id, body) VALUES ($1,$2) RETURNING *', [id, b.body]));
  });
  app.put('/api/notes/:noteId', async (c) => {
    const b = z.object({ body: z.string().min(1).max(20000) }).parse(await readJson(c));
    return c.json(await db.one('UPDATE user_notes SET body = $2, updated_at = now() WHERE id::text = $1 RETURNING *', [c.req.param('noteId'), b.body]));
  });
  app.delete('/api/notes/:noteId', async (c) => {
    await db.query('UPDATE user_notes SET deleted_at = now() WHERE id::text = $1', [c.req.param('noteId')]);
    return c.json({ ok: true });
  });

  app.put('/api/opportunities/:id/tags', async (c) => {
    const id = await exists(c.req.param('id'));
    const b = z.object({ tags: z.array(z.string().trim().min(1).max(40)).max(30) }).parse(await readJson(c));
    await db.tx(async (tx) => {
      await tx.query('DELETE FROM user_tags WHERE opportunity_id = $1', [id]);
      for (const t of new Set(b.tags)) await tx.query('INSERT INTO user_tags (opportunity_id, tag) VALUES ($1,$2)', [id, t]);
    });
    return c.json({ tags: b.tags });
  });

  app.put('/api/opportunities/:id/overrides', async (c) => {
    const id = await exists(c.req.param('id'));
    const b = z.object({ field: z.enum(['response_deadline', 'set_aside_code', 'naics_code', 'contract_vehicle', 'performance_start', 'performance_end', 'title']), value: z.union([z.string(), z.number(), z.null()]), note: z.string().max(1000).nullable().optional() }).parse(await readJson(c));
    if (b.value === null) await db.query('DELETE FROM user_field_overrides WHERE opportunity_id = $1 AND field = $2', [id, b.field]);
    else
      await db.query(`INSERT INTO user_field_overrides (opportunity_id, field, value, note) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (opportunity_id, field) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note`, [
        id,
        b.field,
        json(b.value),
        b.note ?? null,
      ]);
    await recomputeOpportunity(db, id, { priorities: await connectorPriorities(db) });
    return c.json({ ok: true });
  });

  app.post('/api/opportunities/:id/view', async (c) => {
    const id = await exists(c.req.param('id'));
    await db.query(`INSERT INTO opportunity_views (opportunity_id) VALUES ($1) ON CONFLICT (opportunity_id) DO UPDATE SET last_viewed_at = now(), view_count = opportunity_views.view_count + 1`, [id]);
    return c.json({ ok: true });
  });

  app.post('/api/opportunities/:id/refresh', async (c) => {
    const id = await exists(c.req.param('id'));
    const result = await refreshOpportunity(deps, id);
    return c.json(result);
  });

  app.post('/api/opportunities/:id/analyze', async (c) => {
    const id = await exists(c.req.param('id'));
    const b = z.object({ force: z.boolean().optional() }).parse(await readJson(c).catch(() => ({})));
    const out = await analyzeOpportunity(db, createAiProvider(deps.config), id, { force: b.force });
    if (out.status === 'success' || out.status === 'cached') {
      const { scoreMany } = await import('../scoring/run');
      await scoreMany(db, [id], 'AI analysis');
    }
    return c.json(out);
  });

  app.post('/api/opportunities/:id/relationships', async (c) => {
    const id = await exists(c.req.param('id'));
    const b = z.object({ otherId: z.string().uuid(), type: z.enum(['related', 'predecessor', 'successor', 'forecast_of', 'possible_same_procurement']), note: z.string().max(500).optional() }).parse(await readJson(c));
    await exists(b.otherId);
    const relId = await upsertRelationship(db, id, b.otherId, b.type, 1, 'manual', [b.note ?? 'Linked manually'], 'user');
    await recordEvent(db, id, { type: 'RELATIONSHIP_FOUND', title: `Manually linked as ${b.type.replace(/_/g, ' ')}`, dedupeKey: `manual-rel:${relId}` });
    return c.json({ id: relId });
  });

  app.put('/api/opportunities/:id/awards/:awardId', async (c) => {
    const id = await exists(c.req.param('id'));
    const b = z.object({ status: z.enum(['active', 'rejected']), relationship: z.string().optional() }).parse(await readJson(c));
    await db.query(`UPDATE opportunity_awards SET status = $3 WHERE opportunity_id = $1 AND award_id::text = $2 ${b.relationship ? 'AND relationship = $4' : ''}`, [id, c.req.param('awardId'), b.status, ...(b.relationship ? [b.relationship] : [])]);
    if (b.status === 'rejected') {
      await db.query(`DELETE FROM opportunity_vendors WHERE opportunity_id = $1 AND role = 'possible_incumbent' AND vendor_id IN (SELECT vendor_id FROM awards WHERE id::text = $2)`, [id, c.req.param('awardId')]);
      await db.query(`UPDATE opportunity_financials SET is_current = false WHERE opportunity_id = $1 AND award_id::text = $2 AND provenance = 'derived'`, [id, c.req.param('awardId')]);
    }
    await recomputeOpportunity(db, id, { priorities: await connectorPriorities(db) });
    return c.json({ ok: true });
  });

  app.get('/api/opportunities/:id/preference', async (c) => {
    const id = await exists(c.req.param('id'));
    const history = await db.query('SELECT fit_score, preference_score, model_version, reason, computed_at FROM score_history WHERE opportunity_id = $1 ORDER BY computed_at DESC LIMIT 50', [id]);
    const model = await loadActiveModel(db);
    const feat = await db.one<{ detail: any }>(`SELECT detail FROM match_explanations WHERE opportunity_id = $1 AND kind = 'features'`, [id]);
    return c.json({ history, model: { version: model.version, stage: model.stage, alpha: model.alpha, sampleCount: model.sampleCount }, contributions: contributions(model, feat?.detail?.features ?? {}, 12) });
  });

  app.get('/api/opportunities/:id/search-related', async (c) => {
    const id = await exists(c.req.param('id'));
    const q = c.req.query('q') ?? '';
    const rows = await db.query(
      `SELECT id, title, stage, solicitation_number, department_name, posted_at FROM opportunities WHERE merged_into_id IS NULL AND id <> $1 AND (title ILIKE $2 OR solicitation_number ILIKE $2) ORDER BY posted_at DESC NULLS LAST LIMIT 15`,
      [id, `%${q}%`],
    );
    return c.json(rows);
  });
}
