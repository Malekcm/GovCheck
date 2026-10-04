import type { Hono } from 'hono';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { OPEN_PURSUIT_STAGES, PURSUIT_DECISIONS, PURSUIT_STAGES, PURSUIT_STAGE_LABELS, STAGE_LABELS, type Stage } from '../../shared/domain';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { json } from '../db';
import { neutralizeFormula, toCsv } from '../lib/csv';
import { formatRange } from '../lib/money';
import { loadCompanyContext } from '../scoring/profile';
import { getLastVisit, includeGrantsDefault } from './meta';
import { buildOpportunityQuery, DECISION_JOIN, LIST_COLUMNS, OpportunityFilters } from './query';

const CaptureInput = z.object({
  pursuit_stage: z.enum(PURSUIT_STAGES).optional(),
  owner: z.string().trim().max(120).nullable().optional(),
  priority: z.enum(['high', 'medium', 'low']).nullable().optional(),
  win_probability: z.number().int().min(0).max(100).nullable().optional(),
  next_action: z.string().trim().max(500).nullable().optional(),
  next_action_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  proposal_deadline: z.string().max(40).nullable().optional(),
  bid_decision: z.enum(['bid', 'no_bid', 'pending']).nullable().optional(),
  partners: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  capture_notes: z.string().max(20000).nullable().optional(),
  win_themes: z.string().max(10000).nullable().optional(),
  risks: z.string().max(10000).nullable().optional(),
  questions: z.string().max(10000).nullable().optional(),
});
type CaptureInputT = z.infer<typeof CaptureInput>;
const CAPTURE_FIELDS = Object.keys(CaptureInput.shape) as (keyof CaptureInputT)[];

/** Opportunity list export columns. Every value that can be inferred says how it was derived. */
export const EXPORT_COLUMNS: [string, (r: any) => unknown][] = [
  ['Review priority', (r) => r.priority_score],
  ['Fit score', (r) => r.fit_score],
  ['Personalized score', (r) => r.preference_score],
  ['Eligibility', (r) => r.eligibility_status],
  ['Strategic attractiveness', (r) => r.attractiveness_score],
  ['Data confidence', (r) => r.confidence_score],
  ['Decision', (r) => r.decision],
  ['Decision reasons', (r) => r.decision_reasons],
  ['Capture stage', (r) => r.pursuit_stage],
  ['Capture owner', (r) => r.capture_owner],
  ['Next action', (r) => r.next_action],
  ['Next action date', (r) => r.next_action_date],
  ['Title', (r) => r.title],
  ['Class', (r) => r.opportunity_class],
  ['Stage', (r) => STAGE_LABELS[r.stage as Stage] ?? r.stage],
  ['Notice type', (r) => r.notice_type],
  ['Intelligence signal (not a solicitation)', (r) => (r.is_signal ? 'YES' : '')],
  ['Status', (r) => r.status],
  ['Solicitation number', (r) => r.solicitation_number],
  ['Department', (r) => r.department_name],
  ['Sub-agency', (r) => r.subtier_name],
  ['Office', (r) => r.office_name],
  ['NAICS', (r) => r.naics_code],
  ['PSC', (r) => r.psc_code],
  ['Set-aside', (r) => r.set_aside ?? r.set_aside_code],
  ['Contract vehicle', (r) => r.contract_vehicle],
  ['Value', (r) => formatRange(r.value_low, r.value_high)],
  ['Value low', (r) => r.value_low],
  ['Value high', (r) => r.value_high],
  ['Value represents', (r) => r.value_label],
  ['Value provenance (OFFICIAL/DERIVED/ESTIMATED/…)', (r) => (r.value_provenance ? String(r.value_provenance).toUpperCase() : 'UNKNOWN')],
  ['Response deadline', (r) => r.response_deadline],
  ['Posted', (r) => r.posted_at],
  ['Period of performance end', (r) => r.performance_end],
  ['Place of performance', (r) => [r.place_city, r.place_state].filter(Boolean).join(', ')],
  ['Incumbent', (r) => r.incumbent_name],
  ['Sources', (r) => r.connector_ids],
  ['Source status', (r) => r.seen_status],
  ['Data completeness %', (r) => r.data_completeness],
  ['First seen', (r) => r.first_seen_at],
  ['Last changed', (r) => r.last_changed_at],
  ['Source URL', (r) => r.primary_url],
  ['Profile ID', (r) => r.id],
];

export function registerBdRoutes(app: Hono, deps: AppDeps) {
  const { db } = deps;

  const oppExists = async (id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpProblem(404, 'Not found');
    const o = await db.one<{ id: string }>('SELECT id FROM opportunities WHERE id = $1', [id]);
    if (!o) throw new HttpProblem(404, 'Opportunity not found');
    return o.id;
  };

  // ---------------------------------------------------------------------------
  // Capture record (user-owned; journaled; never written by sync)
  // ---------------------------------------------------------------------------
  app.get('/api/opportunities/:id/capture', async (c) => {
    const id = await oppExists(c.req.param('id'));
    const capture = await db.one('SELECT * FROM opportunity_capture WHERE opportunity_id = $1', [id]);
    const history = await db.query('SELECT changes, changed_at FROM opportunity_capture_history WHERE opportunity_id = $1 ORDER BY changed_at DESC LIMIT 100', [id]);
    return c.json({ capture, history });
  });

  app.put('/api/opportunities/:id/capture', async (c) => {
    const id = await oppExists(c.req.param('id'));
    const body = CaptureInput.parse(await readJson(c));
    const result = await db.tx(async (tx) => {
      const prev = await tx.one<Record<string, unknown>>('SELECT * FROM opportunity_capture WHERE opportunity_id = $1', [id]);
      if (!prev) await tx.query('INSERT INTO opportunity_capture (opportunity_id) VALUES ($1)', [id]);
      const changes: Record<string, [unknown, unknown]> = {};
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const f of CAPTURE_FIELDS) {
        if (body[f] === undefined) continue;
        const before = prev ? prev[f] : null;
        const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ?? null);
        if (JSON.stringify(norm(before)) === JSON.stringify(norm(body[f]))) continue;
        changes[f] = [norm(before), body[f]];
        params.push(body[f]);
        sets.push(`${f} = $${params.length}${f === 'partners' ? '::text[]' : ''}`);
      }
      if (sets.length) {
        await tx.query(`UPDATE opportunity_capture SET ${sets.join(', ')}, updated_at = now() WHERE opportunity_id = $1`, params);
        await tx.query('INSERT INTO opportunity_capture_history (opportunity_id, changes) VALUES ($1, $2::jsonb)', [id, json(changes)]);
      }
      return tx.one('SELECT * FROM opportunity_capture WHERE opportunity_id = $1', [id]);
    });
    return c.json(result);
  });

  /** Capture pipeline board: one row per tracked opportunity, grouped by pursuit stage. */
  app.get('/api/pipeline', async (c) => {
    const includeClosed = c.req.query('closed') === 'true';
    const rows = await db.query<any>(
      `SELECT ${LIST_COLUMNS}, cap.priority AS capture_priority, cap.win_probability, cap.proposal_deadline, cap.bid_decision, cap.partners, cap.updated_at AS capture_updated_at
       FROM opportunities o ${DECISION_JOIN}
       WHERE o.merged_into_id IS NULL AND (cap.opportunity_id IS NOT NULL OR d.decision = ANY($1::text[]))
         AND ($2::boolean OR cap.pursuit_stage IS NULL OR cap.pursuit_stage = ANY($3::text[]))
       ORDER BY cap.next_action_date ASC NULLS LAST, COALESCE(cap.proposal_deadline, o.response_deadline) ASC NULLS LAST, o.priority_score DESC NULLS LAST
       LIMIT 1000`,
      [PURSUIT_DECISIONS, includeClosed, OPEN_PURSUIT_STAGES],
    );
    const stages = PURSUIT_STAGES.map((s) => ({ stage: s, label: PURSUIT_STAGE_LABELS[s], items: rows.filter((r) => (r.pursuit_stage ?? 'discovered') === s) })).filter(
      (g) => includeClosed || OPEN_PURSUIT_STAGES.includes(g.stage),
    );
    const today = new Date().toISOString().slice(0, 10);
    const overdue = rows.filter((r) => r.next_action_date && String(r.next_action_date instanceof Date ? r.next_action_date.toISOString() : r.next_action_date).slice(0, 10) < today);
    const weighted = rows.reduce((s, r) => s + (r.win_probability != null && (r.value_high ?? r.value_low) ? ((r.value_high ?? r.value_low) * r.win_probability) / 100 : 0), 0);
    return c.json({ stages, total: rows.length, overdueActions: overdue.length, weightedOfficialOrEstimatedValue: weighted });
  });

  // ---------------------------------------------------------------------------
  // Data quality & coverage — is GovCheck actually seeing the market?
  // ---------------------------------------------------------------------------
  app.get('/api/data-quality', async (c) => {
    const sources = await db.query(
      `SELECT sc.id, sc.name, sc.source_type, sc.enabled, sc.health, sc.health_message, sc.last_success_at, sc.last_attempted_at,
         r.status AS last_status, r.records_retrieved AS last_retrieved, r.records_created AS last_created, r.records_updated AS last_updated, r.records_failed AS last_failed,
         r.api_requests AS last_api_requests, r.finished_at AS last_finished_at,
         (SELECT count(*)::int FROM source_records s WHERE s.connector_id = sc.id) AS stored_records,
         (SELECT count(*)::int FROM source_records s WHERE s.connector_id = sc.id AND s.seen_status = 'not_seen') AS not_seen_records,
         (SELECT count(*)::int FROM sync_errors e WHERE e.connector_id = sc.id AND e.created_at > now() - interval '7 days') AS errors_7d,
         (SELECT count(*)::int FROM sync_errors e WHERE e.connector_id = sc.id AND e.step = 'coverage' AND e.created_at > now() - interval '30 days') AS coverage_warnings_30d,
         (SELECT count(*)::int FROM sync_runs x WHERE x.connector_id = sc.id AND x.status = 'failed' AND x.created_at > now() - interval '7 days') AS failed_runs_7d,
         (SELECT count(*)::int FROM source_records s WHERE s.connector_id = sc.id AND s.normalized IS NULL) AS unnormalized_records
       FROM source_connectors sc LEFT JOIN sync_runs r ON r.id = sc.last_run_id
       WHERE sc.source_type <> 'engine' ORDER BY sc.priority`,
    );
    const budget = await db.query(`SELECT connector_id, usage_date, requests FROM api_usage WHERE usage_date >= current_date - 6 ORDER BY usage_date DESC`);
    const recentErrors = await db.query(
      `SELECT e.connector_id, e.step, e.message, e.record_ref, e.created_at FROM sync_errors e WHERE e.created_at > now() - interval '7 days' ORDER BY e.created_at DESC LIMIT 40`,
    );
    const active = `o.merged_into_id IS NULL AND o.status IN ('active','forecast','signal')`;
    const gaps = await db.one<any>(
      `SELECT
         count(*)::int AS active_total,
         count(*) FILTER (WHERE o.value_low IS NULL AND o.value_high IS NULL)::int AS missing_value,
         count(*) FILTER (WHERE o.value_provenance IN ('estimated','derived'))::int AS estimated_value_only,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM opportunity_contacts oc WHERE oc.opportunity_id = o.id))::int AS missing_contacts,
         count(*) FILTER (WHERE o.stage IN ('solicitation','combined_synopsis') AND NOT o.has_documents)::int AS solicitations_missing_documents,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opportunity_documents d WHERE d.opportunity_id = o.id AND d.text_status = 'ocr_needed'))::int AS documents_needing_ocr,
         count(*) FILTER (WHERE o.naics_code IS NULL)::int AS missing_naics,
         count(*) FILTER (WHERE o.agency_id IS NULL)::int AS unresolved_agency,
         count(*) FILTER (WHERE o.office_id IS NULL AND o.opportunity_class = 'prime')::int AS unresolved_office,
         count(*) FILTER (WHERE o.response_deadline IS NULL AND o.stage IN ('solicitation','combined_synopsis','sources_sought','rfi'))::int AS missing_deadline,
         count(*) FILTER (WHERE (o.is_signal OR o.recompete_signal) AND NOT o.has_incumbent)::int AS recompete_without_incumbent,
         count(*) FILTER (WHERE o.seen_status = 'not_seen' OR o.last_seen_at < now() - interval '30 days')::int AS stale,
         count(*) FILTER (WHERE o.description IS NULL OR length(o.description) < 80)::int AS thin_description,
         count(*) FILTER (WHERE o.fit_score IS NULL)::int AS unscored
       FROM opportunities o WHERE ${active}`,
    );
    const docs = await db.query(`SELECT retrieval_status, text_status, count(*)::int AS n FROM opportunity_documents GROUP BY 1, 2 ORDER BY 3 DESC`);
    const duplicates = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM opportunity_relationships WHERE status = 'suggested' AND relationship_type IN ('possible_duplicate','possible_same_procurement')`,
    );
    const unmatched = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM source_records sr WHERE sr.record_kind <> 'award' AND sr.normalized IS NOT NULL AND NOT EXISTS (SELECT 1 FROM opportunity_sources os WHERE os.source_record_id = sr.id)`,
    );
    const orphanAwards = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM coverage_signals WHERE status = 'open' AND signal_type = 'ORPHAN_AWARD'`);
    const byStage = await db.query(
      `SELECT o.stage, c AS connector, count(*)::int AS n FROM opportunities o, unnest(o.connector_ids) c WHERE ${active} GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
    );
    const byAgency = await db.query(
      `SELECT COALESCE(o.department_name, '(unresolved)') AS agency, count(*)::int AS n,
         count(*) FILTER (WHERE o.connector_ids && ARRAY['sam_opportunities','sam_bulk']::text[])::int AS on_sam,
         count(*) FILTER (WHERE o.stage = 'forecast')::int AS forecasts,
         count(*) FILTER (WHERE o.is_signal)::int AS recompete_signals,
         count(*) FILTER (WHERE COALESCE(o.fit_score,0) >= 60)::int AS strong_fit
       FROM opportunities o WHERE ${active} GROUP BY 1 ORDER BY 2 DESC LIMIT 40`,
    );
    return c.json({ sources, budget, recentErrors, gaps, documents: docs, pendingDuplicates: duplicates?.n ?? 0, unmatchedSourceRecords: unmatched?.n ?? 0, orphanAwards: orphanAwards?.n ?? 0, byStage, byAgency });
  });

  // ---------------------------------------------------------------------------
  // Expiring contracts in the company's market (recompete pipeline)
  // ---------------------------------------------------------------------------
  app.get('/api/intel/expiring', async (c) => {
    const months = z.coerce.number().int().min(1).max(36).default(18).parse(c.req.query('months') ?? 18);
    const co = await loadCompanyContext(db);
    const naics = co.naics;
    const rows = await db.query<any>(
      `SELECT a.id, a.piid, a.referenced_idv_piid, a.awardee_name, a.vendor_id, a.department_name, a.subtier_name, a.office_name, a.naics_code, a.psc_code,
         a.pop_current_end, a.pop_potential_end, a.total_obligated, a.base_and_all_options, a.extent_competed, a.set_aside, a.pricing_type, a.description, a.idv_type, a.number_of_offers,
         (SELECT json_agg(json_build_object('id', o.id, 'title', o.title, 'stage', o.stage, 'is_signal', o.is_signal, 'relationship', oa.relationship))
            FROM opportunity_awards oa JOIN opportunities o ON o.id = oa.opportunity_id WHERE oa.award_id = a.id AND oa.status = 'active' AND o.merged_into_id IS NULL) AS linked
       FROM awards a
       WHERE a.award_key NOT LIKE 'sam_notice:%' AND a.pop_current_end >= current_date AND a.pop_current_end <= current_date + ($1::int * interval '1 month')
         AND (cardinality($2::text[]) = 0 OR a.naics_code = ANY($2::text[]) OR left(a.naics_code, 4) = ANY(SELECT left(x, 4) FROM unnest($2::text[]) x))
       ORDER BY a.pop_current_end ASC LIMIT 1500`,
      [months, naics],
    );
    const bucket = (end: string) => {
      const m = (new Date(end).getTime() - Date.now()) / (30.4375 * 86_400_000);
      return m <= 3 ? '0-3' : m <= 6 ? '3-6' : m <= 12 ? '6-12' : '12-18+';
    };
    const items = rows.map((r) => {
      const linked = (r.linked ?? []) as any[];
      const successor = linked.find((l) => !l.is_signal && l.relationship !== 'award_of');
      return {
        ...r,
        window: bucket(r.pop_current_end),
        successorStatus: successor ? `Successor tracked: ${STAGE_LABELS[successor.stage as Stage] ?? successor.stage}` : linked.some((l) => l.is_signal) ? 'Recompete signal (no successor notice yet)' : 'Not yet tracked',
        successorId: successor?.id ?? linked[0]?.id ?? null,
        competed: r.extent_competed ? !/not\s+(available|competed)|follow.?on|sole/i.test(r.extent_competed) : null,
      };
    });
    const summary = ['0-3', '3-6', '6-12', '12-18+'].map((w) => {
      const xs = items.filter((i) => i.window === w);
      return { window: w, contracts: xs.length, value: xs.reduce((s, i) => s + Number(i.base_and_all_options ?? i.total_obligated ?? 0), 0), untracked: xs.filter((i) => i.successorStatus === 'Not yet tracked').length };
    });
    return c.json({ months, naicsFilter: naics, summary, items });
  });

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------
  const exportRows = async (query: Record<string, string>) => {
    const f = OpportunityFilters.parse(query);
    const q = buildOpportunityQuery(f, { lastVisit: await getLastVisit(deps), includeGrantsDefault: await includeGrantsDefault(deps) });
    return db.query<any>(`SELECT ${LIST_COLUMNS}, o.primary_url, o.data_completeness FROM opportunities o ${DECISION_JOIN} WHERE ${q.where} ORDER BY ${q.orderBy} LIMIT 50000`, q.params);
  };

  app.get('/api/opportunities/export.xlsx', async (c) => {
    const rows = await exportRows(c.req.query());
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GovCheck';
    const ws = wb.addWorksheet('Opportunities', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = EXPORT_COLUMNS.map(([h]) => ({ header: h, width: Math.min(60, Math.max(12, h.length + 2)) }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow(
        EXPORT_COLUMNS.map(([, f]) => {
          const v = f(r);
          if (v === null || v === undefined) return null;
          if (v instanceof Date) return v;
          if (typeof v === 'number') return v;
          return neutralizeFormula(Array.isArray(v) ? v.join('; ') : String(v));
        }),
      );
    }
    const legend = wb.addWorksheet('About');
    legend.addRows([
      ['GovCheck export', new Date().toISOString()],
      ['Rows', rows.length],
      [],
      ['Value provenance', 'Meaning'],
      ['OFFICIAL', 'Published by a government source.'],
      ['DERIVED', 'Computed deterministically from official data; basis shown in the dossier.'],
      ['ESTIMATED', 'Statistical estimate from comparable awards — never an official figure.'],
      ['AI_EXTRACTED', 'Extracted by AI from source text — verify against the document.'],
      ['USER_ENTERED', 'Entered by your team.'],
      ['UNKNOWN', 'No source has published it yet.'],
      [],
      ['Review priority', 'Personalized fit blended with attractiveness, capped when eligibility is doubtful.'],
    ]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="govcheck-opportunities-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return c.body(buf);
  });

  app.get('/api/changes/export.csv', async (c) => {
    const f = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30), type: z.string().optional() }).parse(c.req.query());
    const rows = await db.query<any>(
      `SELECT e.detected_at, e.occurred_at, e.event_type, e.title, e.field, e.old_value, e.new_value, e.detail, e.connector_id, o.id AS opportunity_id, o.title AS opportunity_title,
         o.solicitation_number, o.department_name, o.fit_score, o.priority_score, d.decision
       FROM opportunity_events e JOIN opportunities o ON o.id = e.opportunity_id ${DECISION_JOIN}
       WHERE e.detected_at >= now() - ($1::int * interval '1 day') AND e.event_type <> 'LIFECYCLE' AND o.merged_into_id IS NULL ${f.type ? 'AND e.event_type = ANY($2::text[])' : ''}
       ORDER BY e.detected_at DESC LIMIT 50000`,
      f.type ? [f.days, f.type.split(',')] : [f.days],
    );
    const body = toCsv(rows, [
      ['Detected', (r) => r.detected_at],
      ['Occurred', (r) => r.occurred_at],
      ['Change type', (r) => r.event_type],
      ['What changed', (r) => r.title],
      ['Field', (r) => r.field],
      ['Old value', (r) => r.old_value],
      ['New value', (r) => r.new_value],
      ['Added scope text', (r) => (Array.isArray(r.detail?.addedSentences) ? r.detail.addedSentences.join(' | ') : '')],
      ['Source', (r) => r.connector_id],
      ['Opportunity', (r) => r.opportunity_title],
      ['Solicitation number', (r) => r.solicitation_number],
      ['Department', (r) => r.department_name],
      ['Fit', (r) => r.fit_score],
      ['Priority', (r) => r.priority_score],
      ['Your decision', (r) => r.decision],
      ['Profile ID', (r) => r.opportunity_id],
    ]);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="govcheck-changes-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(body);
  });

  /** Full dossier as JSON (everything the dossier page shows, with provenance). */
  app.get('/api/opportunities/:id/export.json', async (c) => {
    const id = await oppExists(c.req.param('id'));
    const res = await app.request(`/api/opportunities/${id}`, { headers: c.req.raw.headers });
    if (!res.ok) throw new HttpProblem(res.status === 404 ? 404 : 500, 'Could not build dossier');
    const dossier = await res.json();
    const capture = await db.one('SELECT * FROM opportunity_capture WHERE opportunity_id = $1', [id]);
    c.header('Content-Disposition', `attachment; filename="govcheck-dossier-${id}.json"`);
    return c.json({ exportedAt: new Date().toISOString(), format: 'govcheck-dossier-v1', capture, ...(dossier as object) });
  });

  /** Source / provenance export: every raw source record and every stored version behind a profile. */
  app.get('/api/opportunities/:id/sources.json', async (c) => {
    const id = await oppExists(c.req.param('id'));
    const records = await db.query(
      `SELECT sr.id, sr.connector_id, sr.source_record_id, sr.record_kind, sr.source_url, sr.retrieved_at, sr.first_seen_at, sr.last_seen_at, sr.seen_status, sr.parser_version,
         sr.content_hash, sr.raw, sr.raw_text, sr.normalized, os.link_method, os.confidence, os.evidence
       FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id WHERE os.opportunity_id = $1 ORDER BY sr.first_seen_at`,
      [id],
    );
    const versions = await db.query(
      `SELECT v.source_record_id, v.content_hash, v.parser_version, v.retrieved_at, v.raw, v.raw_text FROM source_record_versions v
       WHERE v.source_record_id IN (SELECT source_record_id FROM opportunity_sources WHERE opportunity_id = $1) ORDER BY v.retrieved_at`,
      [id],
    );
    const fieldValues = await db.query('SELECT * FROM opportunity_field_values WHERE opportunity_id = $1 ORDER BY field, observed_at', [id]);
    c.header('Content-Disposition', `attachment; filename="govcheck-sources-${id}.json"`);
    return c.json({ exportedAt: new Date().toISOString(), format: 'govcheck-provenance-v1', opportunityId: id, records, versions, fieldValues });
  });

  /** Plain-text capture brief (Markdown) for pasting into email / Teams / proposal tools. */
  app.get('/api/opportunities/:id/brief.md', async (c) => {
    const id = await oppExists(c.req.param('id'));
    const res = await app.request(`/api/opportunities/${id}`, { headers: c.req.raw.headers });
    const d = (await res.json()) as any;
    const o = d.opportunity;
    const cap = await db.one<any>('SELECT * FROM opportunity_capture WHERE opportunity_id = $1', [id]);
    const line = (k: string, v: unknown) => (v === null || v === undefined || v === '' ? null : `- **${k}:** ${v}`);
    const md = [
      `# ${o.title}`,
      '',
      [line('Stage', STAGE_LABELS[o.stage as Stage] ?? o.stage), line('Status', o.status), line('Solicitation', o.solicitation_number), line('Agency', [o.department_name, o.subtier_name, o.office_name].filter(Boolean).join(' / ')),
        line('Response deadline', o.response_deadline ? new Date(o.response_deadline).toISOString().slice(0, 10) : null),
        line('Value', o.value_low != null || o.value_high != null ? `${formatRange(o.value_low, o.value_high)} (${String(o.value_provenance ?? 'unknown').toUpperCase()} — ${o.value_label ?? ''})` : 'Unknown'),
        line('Set-aside', o.set_aside ?? o.set_aside_code), line('NAICS / PSC', [o.naics_code, o.psc_code].filter(Boolean).join(' / ')), line('Incumbent', o.incumbent_name),
        line('Scores', `priority ${o.priority_score ?? '—'} · fit ${o.fit_score ?? '—'} · eligibility ${o.eligibility_status ?? '—'} · attractiveness ${o.attractiveness_score ?? '—'} · confidence ${o.confidence_score ?? '—'}`),
        line('Source', o.primary_url)].filter(Boolean).join('\n'),
      '',
      '## Recommended next actions',
      ...(d.recommendedActions ?? []).map((a: any) => `- ${a.action}${a.due ? ` (by ${a.due})` : ''} — ${a.why}`),
      '',
      '## Why it matches',
      ...((d.explanations ?? []) as any[]).filter((e) => e.kind === 'strength').map((e) => `- ${e.text}`),
      '',
      '## Gaps / risks',
      ...((d.explanations ?? []) as any[]).filter((e) => ['gap', 'hard_block', 'verify'].includes(e.kind)).map((e) => `- ${e.text}`),
      '',
      '## Key requirements (derived / AI — verify against documents)',
      ...((d.requirements ?? []) as any[]).slice(0, 25).map((r) => `- [${String(r.provenance).toUpperCase()}${r.strength ? `, ${r.strength}` : ''}] ${r.text}`),
      '',
      '## Contacts',
      ...((d.contacts ?? []) as any[]).map((x) => `- ${x.role}: ${[x.full_name, x.title, x.email, x.phone].filter(Boolean).join(', ')}`),
      '',
      ...(cap ? ['## Capture', line('Stage', PURSUIT_STAGE_LABELS[cap.pursuit_stage as keyof typeof PURSUIT_STAGE_LABELS]), line('Owner', cap.owner), line('Next action', cap.next_action), line('Win themes', cap.win_themes), line('Risks', cap.risks)].filter(Boolean) as string[] : []),
      '',
      `_Generated by GovCheck ${new Date().toISOString()}. Values marked DERIVED/ESTIMATED/AI are not official._`,
    ].join('\n');
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="capture-brief-${id}.md"`);
    return c.body(md);
  });
}

