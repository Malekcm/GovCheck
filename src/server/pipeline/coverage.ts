import type { Db } from '../db';
import { json } from '../db';

interface Signal {
  type: string;
  key: string;
  title: string;
  opportunityId?: string | null;
  awardId?: string | null;
  severity: 'info' | 'notice' | 'important';
  detail?: Record<string, unknown>;
}

/**
 * Coverage analysis: find what a single-source workflow would miss, and data gaps that
 * need attention. Signals are upserted by key; signals no longer detected are resolved
 * (kept for history). User-dismissed signals stay dismissed.
 */
export async function computeCoverage(db: Db, opts: { companyNaics?: string[] } = {}): Promise<{ open: number; byType: Record<string, number> }> {
  const signals: Signal[] = [];
  const add = (s: Signal) => signals.push(s);

  const forecastOnly = await db.query<{ id: string; title: string; posted_at: string | null; fy_end: string | null }>(
    `SELECT o.id, o.title, o.posted_at,
       (SELECT max(date_value) FROM opportunity_dates d WHERE d.opportunity_id = o.id AND d.kind = 'forecast_award_fy' AND d.is_current) AS fy_end
     FROM opportunities o WHERE o.merged_into_id IS NULL AND o.stage = 'forecast' AND o.connector_ids <@ ARRAY['gsa_forecast','dhs_apfs']::text[] AND cardinality(o.connector_ids) > 0 AND o.status <> 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM opportunity_relationships r WHERE r.status <> 'rejected' AND r.relationship_type IN ('forecast_of','possible_same_procurement') AND (r.from_opportunity_id = o.id OR r.to_opportunity_id = o.id))
       AND COALESCE(o.fit_score, 0) >= 30`,
  );
  for (const o of forecastOnly) {
    const overdue = o.fy_end && new Date(o.fy_end).getTime() < Date.now();
    add({
      type: overdue ? 'FORECAST_OVERDUE' : 'FORECAST_ONLY',
      key: `${overdue ? 'FORECAST_OVERDUE' : 'FORECAST_ONLY'}:${o.id}`,
      title: overdue ? `Forecast award year has passed with no solicitation linked: ${o.title}` : `Exists in an agency forecast, not yet on SAM: ${o.title}`,
      opportunityId: o.id,
      severity: overdue ? 'notice' : 'info',
    });
  }

  for (const o of await db.query<{ id: string; title: string }>(
    `SELECT id, title FROM opportunities WHERE merged_into_id IS NULL AND opportunity_class = 'subcontract' AND status = 'active' AND COALESCE(fit_score,0) >= 30`,
  ))
    add({ type: 'SUBCONTRACT_ONLY', key: `SUBCONTRACT_ONLY:${o.id}`, title: `Exists on SUBNet, not on SAM: ${o.title}`, opportunityId: o.id, severity: 'info' });

  for (const o of await db.query<{ id: string; title: string; connector_ids: string[] }>(
    `SELECT id, title, connector_ids FROM opportunities WHERE merged_into_id IS NULL AND opportunity_class = 'prime' AND NOT is_signal AND stage <> 'forecast'
       AND NOT (connector_ids && ARRAY['sam_opportunities','sam_bulk','sam_awards','usaspending']::text[]) AND cardinality(connector_ids) > 0`,
  ))
    add({ type: 'NO_SAM_MATCH', key: `NO_SAM_MATCH:${o.id}`, title: `Found in ${o.connector_ids.join(', ')} with no SAM.gov notice: ${o.title}`, opportunityId: o.id, severity: 'info' });

  for (const o of await db.query<{ id: string; title: string; performance_end: string | null }>(
    `SELECT id, title, performance_end FROM opportunities WHERE merged_into_id IS NULL AND is_signal AND status = 'signal'`,
  ))
    add({ type: 'POSSIBLE_RECOMPETE', key: `POSSIBLE_RECOMPETE:${o.id}`, title: o.title, opportunityId: o.id, severity: 'important', detail: { performanceEnd: o.performance_end } });

  for (const o of await db.query<{ id: string; title: string }>(
    `SELECT o.id, o.title FROM opportunities o WHERE o.merged_into_id IS NULL AND o.stage = 'award'
       AND NOT EXISTS (SELECT 1 FROM opportunity_awards oa JOIN awards a ON a.id = oa.award_id WHERE oa.opportunity_id = o.id AND a.award_key NOT LIKE 'sam_notice:%')
       AND COALESCE(o.fit_score,0) >= 40`,
  ))
    add({ type: 'NO_AWARD_LINK', key: `NO_AWARD_LINK:${o.id}`, title: `Award notice without a linked contract record: ${o.title}`, opportunityId: o.id, severity: 'info' });

  if (opts.companyNaics?.length) {
    for (const a of await db.query<{ id: string; piid: string; solicitation_id: string; awardee_name: string | null }>(
      `SELECT a.id, a.piid, a.solicitation_id, a.awardee_name FROM awards a
       WHERE a.solicitation_key IS NOT NULL AND a.award_key NOT LIKE 'sam_notice:%' AND a.naics_code = ANY($1::text[]) AND a.date_signed >= current_date - interval '3 years'
         AND NOT EXISTS (SELECT 1 FROM opportunity_awards oa WHERE oa.award_id = a.id) LIMIT 500`,
      [opts.companyNaics],
    ))
      add({ type: 'ORPHAN_AWARD', key: `ORPHAN_AWARD:${a.id}`, title: `Award ${a.piid} (${a.awardee_name ?? 'unknown'}) references solicitation ${a.solicitation_id}, which is not in the database`, awardId: a.id, severity: 'info' });
  }

  for (const r of await db.query<{ id: string; from_opportunity_id: string; to_opportunity_id: string; relationship_type: string; confidence: number; t1: string; t2: string }>(
    `SELECT r.id, r.from_opportunity_id, r.to_opportunity_id, r.relationship_type, r.confidence, o1.title AS t1, o2.title AS t2
     FROM opportunity_relationships r JOIN opportunities o1 ON o1.id = r.from_opportunity_id JOIN opportunities o2 ON o2.id = r.to_opportunity_id
     WHERE r.status = 'suggested' AND r.relationship_type IN ('possible_duplicate','possible_same_procurement') AND o1.merged_into_id IS NULL AND o2.merged_into_id IS NULL`,
  ))
    add({ type: 'POSSIBLE_DUPLICATE', key: `POSSIBLE_DUPLICATE:${r.id}`, title: `“${r.t1}” may be the same procurement as “${r.t2}”`, opportunityId: r.from_opportunity_id, severity: 'notice', detail: { relationshipId: r.id, other: r.to_opportunity_id, confidence: r.confidence } });

  for (const o of await db.query<{ id: string; title: string }>(
    `SELECT id, title FROM opportunities WHERE merged_into_id IS NULL AND stage IN ('solicitation','combined_synopsis') AND status = 'active' AND NOT has_documents AND COALESCE(fit_score,0) >= 40`,
  ))
    add({ type: 'MISSING_DOCUMENTS', key: `MISSING_DOCUMENTS:${o.id}`, title: `Active solicitation with no documents captured: ${o.title}`, opportunityId: o.id, severity: 'info' });

  for (const c of await db.query<{ opportunity_id: string; field: string; title: string; vals: string[] }>(
    `SELECT fv.opportunity_id, fv.field, o.title, array_agg(DISTINCT fv.value_text) AS vals
     FROM opportunity_field_values fv JOIN opportunities o ON o.id = fv.opportunity_id
     WHERE fv.is_current AND fv.provenance = 'official' AND fv.field IN ('response_deadline','set_aside_code','naics_code','solicitation_number') AND o.merged_into_id IS NULL
     GROUP BY fv.opportunity_id, fv.field, o.title HAVING count(DISTINCT fv.value_text) > 1`,
  )) {
    // Deadlines legitimately differ across lifecycle notices (sources sought vs solicitation); only flag same-stage conflicts.
    if (c.field === 'response_deadline') {
      const sameStage = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM (SELECT sr.normalized->'data'->>'stage' AS st, count(DISTINCT fv.value_text) AS k FROM opportunity_field_values fv JOIN source_records sr ON sr.id = fv.source_record_id
         WHERE fv.opportunity_id = $1 AND fv.field = 'response_deadline' AND fv.is_current GROUP BY 1 HAVING count(DISTINCT fv.value_text) > 1) x`,
        [c.opportunity_id],
      );
      if (!sameStage?.n) continue;
    }
    add({ type: 'SOURCE_CONFLICT', key: `SOURCE_CONFLICT:${c.opportunity_id}:${c.field}`, title: `Sources disagree on ${c.field.replace(/_/g, ' ')} (${c.vals.slice(0, 3).join(' vs ')}): ${c.title}`, opportunityId: c.opportunity_id, severity: 'notice', detail: { field: c.field, values: c.vals } });
  }

  for (const o of await db.query<{ id: string; title: string; last_seen_at: string }>(
    `SELECT id, title, last_seen_at FROM opportunities WHERE merged_into_id IS NULL AND status = 'active' AND (seen_status = 'not_seen' OR last_seen_at < now() - interval '30 days') AND NOT is_signal`,
  ))
    add({ type: 'STALE_RECORD', key: `STALE_RECORD:${o.id}`, title: `Not seen in recent refreshes: ${o.title}`, opportunityId: o.id, severity: 'info', detail: { lastSeen: o.last_seen_at } });

  for (const o of await db.query<{ id: string; title: string }>(
    `SELECT o.id, o.title FROM opportunities o WHERE o.merged_into_id IS NULL AND o.stage IN ('sources_sought','rfi') AND o.posted_at < now() - interval '90 days'
       AND COALESCE(o.fit_score,0) >= 40
       AND NOT EXISTS (SELECT 1 FROM opportunity_relationships r WHERE r.status <> 'rejected' AND (r.from_opportunity_id = o.id OR r.to_opportunity_id = o.id) AND r.relationship_type IN ('possible_same_procurement','successor','predecessor'))`,
  ))
    add({ type: 'SOURCES_SOUGHT_NO_FOLLOWUP', key: `SOURCES_SOUGHT_NO_FOLLOWUP:${o.id}`, title: `Sources Sought/RFI over 90 days old with no linked solicitation: ${o.title}`, opportunityId: o.id, severity: 'notice' });

  for (const o of await db.query<{ id: string; title: string }>(
    `SELECT o.id, o.title FROM opportunities o WHERE o.merged_into_id IS NULL AND o.stage IN ('solicitation','combined_synopsis') AND COALESCE(o.fit_score,0) >= 70 AND NOT (o.connector_ids && ARRAY['gsa_forecast','dhs_apfs']::text[])
       AND NOT EXISTS (SELECT 1 FROM opportunity_relationships r WHERE r.status <> 'rejected' AND r.relationship_type = 'forecast_of' AND (r.from_opportunity_id = o.id OR r.to_opportunity_id = o.id))`,
  ))
    add({ type: 'NO_FORECAST_LINK', key: `NO_FORECAST_LINK:${o.id}`, title: `Strong-fit solicitation with no forecast linked: ${o.title}`, opportunityId: o.id, severity: 'info' });

  const keys = signals.map((s) => s.key);
  if (signals.length) {
    await db.query(
      `INSERT INTO coverage_signals (signal_type, opportunity_id, award_id, signal_key, title, detail, severity, status)
       SELECT x.type, x.opportunity_id, x.award_id, x.key, x.title, x.detail, x.severity, 'open'
       FROM jsonb_to_recordset($1::jsonb) AS x(type text, opportunity_id uuid, award_id uuid, key text, title text, detail jsonb, severity text)
       ON CONFLICT (signal_key) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, severity = EXCLUDED.severity, last_detected_at = now(),
         status = CASE WHEN coverage_signals.status = 'dismissed' THEN 'dismissed' ELSE 'open' END, resolved_at = NULL`,
      [json(signals.map((s) => ({ type: s.type, opportunity_id: s.opportunityId ?? null, award_id: s.awardId ?? null, key: s.key, title: s.title, detail: s.detail ?? {}, severity: s.severity })))],
    );
  }
  await db.query(`UPDATE coverage_signals SET status = 'resolved', resolved_at = now() WHERE status = 'open' AND NOT (signal_key = ANY($1::text[]))`, [keys]);
  const counts = await db.query<{ signal_type: string; n: number }>(`SELECT signal_type, count(*)::int AS n FROM coverage_signals WHERE status = 'open' GROUP BY signal_type`);
  const byType = Object.fromEntries(counts.map((c) => [c.signal_type, c.n]));
  return { open: counts.reduce((s, c) => s + c.n, 0), byType };
}
