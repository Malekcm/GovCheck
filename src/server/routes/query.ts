import { z } from 'zod';

const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)));
const num = z.coerce.number().optional();
const bool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'));

export const OpportunityFilters = z.object({
  q: z.string().max(300).optional(),
  minFit: num,
  maxFit: num,
  minPref: num,
  eligibility: csv,
  decision: csv,
  stage: csv,
  opportunityClass: csv,
  source: csv,
  agency: z.string().max(200).optional(),
  agencyId: z.string().uuid().optional(),
  subagency: z.string().max(200).optional(),
  office: z.string().max(200).optional(),
  officeId: z.string().uuid().optional(),
  naics: z.string().max(20).optional(),
  psc: z.string().max(10).optional(),
  setAside: csv,
  vehicle: z.string().max(100).optional(),
  valueMin: num,
  valueMax: num,
  postedFrom: z.string().optional(),
  postedTo: z.string().optional(),
  deadlineFrom: z.string().optional(),
  deadlineTo: z.string().optional(),
  performanceFrom: z.string().optional(),
  performanceTo: z.string().optional(),
  dueWithinDays: num,
  changedWithinDays: num,
  state: z.string().max(40).optional(),
  recompete: bool,
  hasIncumbent: bool,
  hasDocuments: bool,
  newSinceVisit: bool,
  openOnly: bool,
  includeGrants: bool,
  vendorId: z.string().uuid().optional(),
  minAttractiveness: num,
  minConfidence: num,
  /** Period of performance (or incumbent contract) ends within N months from today. */
  expiringWithinMonths: num,
  incumbent: z.string().max(200).optional(),
  noticeType: z.string().max(100).optional(),
  changeType: csv,
  captureStage: csv,
  owner: z.string().max(120).optional(),
  tag: z.string().max(40).optional(),
  status: csv,
  sort: z.enum(['best', 'fit', 'preference', 'attractiveness', 'confidence', 'deadline', 'newest', 'updated', 'value', 'agency', 'completeness', 'expiring', 'next_action']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
});
export type OpportunityFiltersT = z.infer<typeof OpportunityFilters>;

export interface BuiltQuery {
  where: string;
  params: unknown[];
  orderBy: string;
}

/** Translate filters into a parameterized WHERE clause over `opportunities o` (+ current decision `d`). */
export function buildOpportunityQuery(f: OpportunityFiltersT, ctx: { lastVisit: string | null; includeGrantsDefault: boolean }): BuiltQuery {
  const where: string[] = ['o.merged_into_id IS NULL'];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (f.q) {
    const term = f.q.trim();
    const ident = term.toUpperCase().replace(/[\s\-._]+/g, '');
    where.push(
      `(o.search_vector @@ websearch_to_tsquery('english', ${p(term)}) OR o.title ILIKE ${p(`%${term}%`)} OR EXISTS (SELECT 1 FROM opportunity_identifiers oi WHERE oi.opportunity_id = o.id AND oi.normalized_value = ${p(ident)}))`,
    );
  }
  if (f.minFit != null) where.push(`COALESCE(o.fit_score, 0) >= ${p(f.minFit)}`);
  if (f.maxFit != null) where.push(`COALESCE(o.fit_score, 0) <= ${p(f.maxFit)}`);
  if (f.minPref != null) where.push(`COALESCE(o.preference_score, 0) >= ${p(f.minPref)}`);
  if (f.eligibility?.length) where.push(`o.eligibility_status = ANY(${p(f.eligibility)}::text[])`);
  if (f.decision?.length) {
    const named = f.decision.filter((d) => d !== 'none');
    const parts: string[] = [];
    if (named.length) parts.push(`d.decision = ANY(${p(named)}::text[])`);
    if (f.decision.includes('none')) parts.push('d.decision IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.stage?.length) where.push(`o.stage = ANY(${p(f.stage)}::text[])`);
  if (f.opportunityClass?.length) where.push(`o.opportunity_class = ANY(${p(f.opportunityClass)}::text[])`);
  else if (!(f.includeGrants ?? ctx.includeGrantsDefault)) where.push(`o.opportunity_class <> 'grant'`);
  if (f.source?.length) where.push(`o.connector_ids && ${p(f.source)}::text[]`);
  if (f.agencyId) where.push(`(o.agency_id = ${p(f.agencyId)} OR o.subagency_id = $${params.length})`);
  if (f.officeId) where.push(`o.office_id = ${p(f.officeId)}`);
  if (f.agency) where.push(`(o.department_name ILIKE ${p(`%${f.agency}%`)} OR o.subtier_name ILIKE $${params.length})`);
  if (f.subagency) where.push(`o.subtier_name ILIKE ${p(`%${f.subagency}%`)}`);
  if (f.office) where.push(`o.office_name ILIKE ${p(`%${f.office}%`)}`);
  if (f.naics) where.push(`(o.naics_code LIKE ${p(`${f.naics}%`)} OR EXISTS (SELECT 1 FROM unnest(o.naics_codes) n WHERE n LIKE $${params.length}))`);
  if (f.psc) where.push(`o.psc_code ILIKE ${p(`${f.psc}%`)}`);
  if (f.setAside?.length) {
    const none = f.setAside.includes('NONE');
    const codes = f.setAside.filter((s) => s !== 'NONE');
    const parts: string[] = [];
    if (codes.length) parts.push(`o.set_aside_code = ANY(${p(codes)}::text[])`);
    if (none) parts.push('o.set_aside_code IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.vehicle) where.push(`(o.contract_vehicle ILIKE ${p(`%${f.vehicle}%`)} OR EXISTS (SELECT 1 FROM opportunity_requirements r WHERE r.opportunity_id = o.id AND r.is_current AND r.category = 'contract_vehicle' AND r.text ILIKE $${params.length}))`);
  if (f.valueMin != null) where.push(`COALESCE(o.value_high, o.value_low) >= ${p(f.valueMin)}`);
  if (f.valueMax != null) where.push(`COALESCE(o.value_low, o.value_high) <= ${p(f.valueMax)}`);
  if (f.postedFrom) where.push(`o.posted_at >= ${p(f.postedFrom)}::timestamptz`);
  if (f.postedTo) where.push(`o.posted_at <= ${p(f.postedTo)}::timestamptz`);
  if (f.deadlineFrom) where.push(`o.response_deadline >= ${p(f.deadlineFrom)}::timestamptz`);
  if (f.deadlineTo) where.push(`o.response_deadline <= ${p(f.deadlineTo)}::timestamptz`);
  if (f.performanceFrom) where.push(`COALESCE(o.performance_end, o.performance_start) >= ${p(f.performanceFrom)}::date`);
  if (f.performanceTo) where.push(`COALESCE(o.performance_start, o.performance_end) <= ${p(f.performanceTo)}::date`);
  if (f.dueWithinDays != null) where.push(`o.response_deadline >= now() AND o.response_deadline <= now() + (${p(f.dueWithinDays)}::int * interval '1 day')`);
  if (f.changedWithinDays != null) where.push(`o.last_changed_at >= now() - (${p(f.changedWithinDays)}::int * interval '1 day')`);
  if (f.state) where.push(`o.place_state ILIKE ${p(f.state)}`);
  if (f.recompete === true) where.push('(o.is_signal OR o.recompete_signal)');
  if (f.hasIncumbent === true) where.push('o.has_incumbent');
  if (f.hasDocuments === true) where.push('o.has_documents');
  if (f.newSinceVisit && ctx.lastVisit) where.push(`o.first_seen_at > ${p(ctx.lastVisit)}::timestamptz`);
  if (f.openOnly) where.push(`o.status IN ('active','forecast','signal') AND (o.response_deadline IS NULL OR o.response_deadline >= now())`);
  if (f.vendorId) where.push(`EXISTS (SELECT 1 FROM opportunity_vendors ov WHERE ov.opportunity_id = o.id AND ov.vendor_id = ${p(f.vendorId)})`);
  if (f.minAttractiveness != null) where.push(`COALESCE(o.attractiveness_score, 0) >= ${p(f.minAttractiveness)}`);
  if (f.minConfidence != null) where.push(`COALESCE(o.confidence_score, 0) >= ${p(f.minConfidence)}`);
  if (f.expiringWithinMonths != null) where.push(`o.performance_end >= current_date AND o.performance_end <= current_date + (${p(f.expiringWithinMonths)}::int * interval '1 month')`);
  if (f.incumbent) where.push(`(o.incumbent_name ILIKE ${p(`%${f.incumbent}%`)} OR EXISTS (SELECT 1 FROM opportunity_vendors ov JOIN vendors v ON v.id = ov.vendor_id WHERE ov.opportunity_id = o.id AND v.name ILIKE $${params.length}))`);
  if (f.noticeType) where.push(`o.notice_type ILIKE ${p(`%${f.noticeType}%`)}`);
  if (f.changeType?.length) where.push(`EXISTS (SELECT 1 FROM opportunity_events e WHERE e.opportunity_id = o.id AND e.event_type = ANY(${p(f.changeType)}::text[]) AND e.detected_at >= now() - (${p(f.changedWithinDays ?? 30)}::int * interval '1 day'))`);
  if (f.captureStage?.length) where.push(`cap.pursuit_stage = ANY(${p(f.captureStage)}::text[])`);
  if (f.owner) where.push(`cap.owner ILIKE ${p(`%${f.owner}%`)}`);
  if (f.tag) where.push(`EXISTS (SELECT 1 FROM user_tags t WHERE t.opportunity_id = o.id AND t.tag ILIKE ${p(f.tag)})`);
  if (f.status?.length) where.push(`o.status = ANY(${p(f.status)}::text[])`);

  const orderBy: Record<NonNullable<OpportunityFiltersT['sort']>, string> = {
    best: 'o.priority_score DESC NULLS LAST, o.fit_score DESC NULLS LAST, o.last_changed_at DESC',
    fit: 'o.fit_score DESC NULLS LAST, o.preference_score DESC NULLS LAST, o.last_changed_at DESC',
    attractiveness: 'o.attractiveness_score DESC NULLS LAST, o.priority_score DESC NULLS LAST',
    confidence: 'o.confidence_score DESC NULLS LAST, o.priority_score DESC NULLS LAST',
    expiring: 'o.performance_end ASC NULLS LAST, o.priority_score DESC NULLS LAST',
    next_action: 'cap.next_action_date ASC NULLS LAST, o.response_deadline ASC NULLS LAST',
    preference: 'o.preference_score DESC NULLS LAST, o.fit_score DESC NULLS LAST',
    deadline: 'o.response_deadline ASC NULLS LAST, o.fit_score DESC NULLS LAST',
    newest: 'o.first_seen_at DESC',
    updated: 'o.last_changed_at DESC',
    value: 'COALESCE(o.value_high, o.value_low) DESC NULLS LAST',
    agency: 'o.department_name ASC NULLS LAST, o.subtier_name ASC NULLS LAST, o.fit_score DESC NULLS LAST',
    completeness: 'o.data_completeness DESC NULLS LAST',
  };
  return { where: where.join(' AND '), params, orderBy: orderBy[f.sort ?? 'best'] };
}

/** Current decision (d) and capture record (cap) — both user-owned, never written by sync. */
export const DECISION_JOIN = `LEFT JOIN LATERAL (SELECT decision, reasons, decided_at FROM user_opportunity_decisions ud WHERE ud.opportunity_id = o.id AND ud.is_current ORDER BY decided_at DESC LIMIT 1) d ON true
  LEFT JOIN opportunity_capture cap ON cap.opportunity_id = o.id`;

export const LIST_COLUMNS = `o.id, o.title, o.opportunity_class, o.stage, o.notice_type, o.status, o.is_signal, o.solicitation_number, o.department_name, o.subtier_name, o.office_name,
  o.agency_id, o.subagency_id, o.office_id, o.naics_code, o.psc_code, o.set_aside_code, o.set_aside, o.value_low, o.value_high, o.value_provenance, o.value_label,
  o.response_deadline, o.posted_at, o.last_changed_at, o.first_seen_at, o.fit_score, o.preference_score, o.eligibility_status, o.connector_ids, o.data_completeness,
  o.has_documents, o.has_incumbent, o.incumbent_name, o.recompete_signal, o.place_state, o.place_city, o.contract_vehicle, o.performance_end, o.seen_status,
  o.attractiveness_score, o.confidence_score, o.priority_score,
  d.decision, d.reasons AS decision_reasons, cap.pursuit_stage, cap.owner AS capture_owner, cap.next_action, cap.next_action_date`;

/** Opportunities the team is actively following: Pursue / Interested / Watch, or in an active capture stage. Alias `o`. */
export const TRACKED_SQL = `(EXISTS (SELECT 1 FROM user_opportunity_decisions td WHERE td.opportunity_id = o.id AND td.is_current AND td.decision IN ('pursue','interested','watch'))
  OR EXISTS (SELECT 1 FROM opportunity_capture tk WHERE tk.opportunity_id = o.id AND tk.pursuit_stage NOT IN ('discovered','lost','no_bid')))`;
