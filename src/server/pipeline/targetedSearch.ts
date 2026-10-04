import { z } from 'zod';
import type { Db } from '../db';
import { json } from '../db';
import { connectorPriorities } from '../connectors/registry';
import { SAM_BUDGET_KEY, samOpportunitiesAdapter, samSearch, toRecords } from '../connectors/sam/samOpportunities';
import { addDays, parseDate, toSamDate } from '../lib/dates';
import { errorMessage } from '../lib/logger';
import { normalizeIdentifier } from '../lib/ids';
import { scoreMany } from '../scoring/run';
import { BudgetExhaustedError, withBudgetMeta } from './budget';
import { extractDescriptionRequirements } from './documents';
import { emptyStats, ingestRecord, type IngestContext } from './ingest';
import { logSyncError, startRun, type SyncDeps } from './sync';

/**
 * Targeted search: user-initiated, separate from background discovery.
 *
 * 1. The GovCheck database is searched first (free, instant).
 * 2. A live SAM.gov search happens ONLY when the user explicitly asks for it, after being
 *    shown the request estimate, the remaining budget and the exact parameters sent.
 * 3. Live results are ingested through the normal pipeline (source_records, versions,
 *    events, scoring) under the SAM.gov Contract Opportunities connector — never kept as
 *    throwaway search results and never bypassing provenance.
 *
 * Only parameters the public SAM Opportunities API v2 supports are sent: postedFrom/postedTo
 * (required, ≤ 1 year), ncode (one NAICS per call), ccode (PSC), title, organizationName,
 * typeOfSetAside, state, ptype, solnum, noticeid, rdlfrom/rdlto, limit, offset. SAM has no
 * full-text keyword search, so keywords are applied locally to the returned titles.
 */

/** SAM procurement types (ptype) and the notice-type labels SAM returns for them. */
export const SAM_NOTICE_TYPES = [
  { code: 'p', label: 'Presolicitation' },
  { code: 'o', label: 'Solicitation' },
  { code: 'k', label: 'Combined Synopsis/Solicitation' },
  { code: 'r', label: 'Sources Sought' },
  { code: 's', label: 'Special Notice' },
  { code: 'a', label: 'Award Notice' },
  { code: 'u', label: 'Justification' },
  { code: 'i', label: 'Intent to Bundle Requirements (DoD-Funded)' },
  { code: 'g', label: 'Sale of Surplus Property' },
] as const;

/** SAM typeOfSetAside codes. */
export const SAM_SET_ASIDES = [
  { code: 'SBA', label: 'Total Small Business' },
  { code: 'SBP', label: 'Partial Small Business' },
  { code: '8A', label: '8(a) Set-Aside' },
  { code: '8AN', label: '8(a) Sole Source' },
  { code: 'HZC', label: 'HUBZone Set-Aside' },
  { code: 'HZS', label: 'HUBZone Sole Source' },
  { code: 'SDVOSBC', label: 'Service-Disabled Veteran-Owned SB Set-Aside' },
  { code: 'SDVOSBS', label: 'SDVOSB Sole Source' },
  { code: 'WOSB', label: 'Women-Owned SB Set-Aside' },
  { code: 'WOSBSS', label: 'WOSB Sole Source' },
  { code: 'EDWOSB', label: 'Economically Disadvantaged WOSB Set-Aside' },
  { code: 'EDWOSBSS', label: 'EDWOSB Sole Source' },
  { code: 'VSA', label: 'Veteran-Owned SB Set-Aside' },
  { code: 'VSS', label: 'Veteran-Owned SB Sole Source' },
  { code: 'IEE', label: 'Indian Economic Enterprise Set-Aside' },
  { code: 'ISBEE', label: 'Indian Small Business Economic Enterprise Set-Aside' },
] as const;

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const TargetedFilters = z.object({
  naics: z.array(z.string().trim().regex(/^\d{2,6}$/, 'NAICS codes are 2–6 digits')).max(25).default([]),
  /** Sent to SAM as `title` (SAM matches it against notice titles). */
  titlePhrase: z.string().trim().max(200).optional(),
  /** Applied locally (title for live results; title + description in GovCheck). */
  keywords: z.array(z.string().trim().min(2).max(100)).max(20).default([]),
  psc: z.string().trim().max(10).optional(),
  organization: z.string().trim().max(200).optional(),
  setAside: z.array(z.string().trim().max(12)).max(16).default([]),
  states: z.array(z.string().trim().length(2)).max(20).default([]),
  noticeTypes: z.array(z.enum(['p', 'o', 'k', 'r', 's', 'a', 'u', 'i', 'g'])).max(9).default([]),
  solicitationNumber: z.string().trim().max(100).optional(),
  noticeId: z.string().trim().max(100).optional(),
  postedFrom: DateStr.optional(),
  postedTo: DateStr.optional(),
  deadlineFrom: DateStr.optional(),
  deadlineTo: DateStr.optional(),
});
export type TargetedFilters = z.infer<typeof TargetedFilters>;

export interface LivePlan {
  calls: Record<string, string | number>[];
  estimatedRequests: number;
  maxRequests: number;
  /** What GovCheck filters locally because SAM accepts only one value (or no such parameter). */
  localFilters: string[];
  warnings: string[];
  blocked: string | null;
}

const blank = (v: string | undefined | null) => !v || !v.trim();

/** Build the SAM calls for a live search. Pure: never contacts SAM, never spends budget. */
export function planLiveSearch(f: TargetedFilters, maxRequests: number, now = new Date()): LivePlan {
  const warnings: string[] = [];
  const localFilters: string[] = [];
  const to = parseDate(f.postedTo) ?? now;
  let from = parseDate(f.postedFrom) ?? addDays(to, -90);
  if (to.getTime() - from.getTime() > 364 * 86_400_000) {
    from = addDays(to, -364);
    warnings.push('SAM limits the posted-date window to one year; the start date was moved to ' + from.toISOString().slice(0, 10) + '.');
  }
  const base: Record<string, string | number> = { postedFrom: toSamDate(from), postedTo: toSamDate(to), limit: 1000, offset: 0 };
  if (!blank(f.titlePhrase)) base.title = f.titlePhrase!;
  if (!blank(f.psc)) base.ccode = f.psc!.toUpperCase();
  if (!blank(f.organization)) base.organizationName = f.organization!;
  if (!blank(f.solicitationNumber)) base.solnum = f.solicitationNumber!;
  if (!blank(f.noticeId)) base.noticeid = f.noticeId!;
  if (f.deadlineFrom) base.rdlfrom = toSamDate(parseDate(f.deadlineFrom)!);
  if (f.deadlineTo) base.rdlto = toSamDate(parseDate(f.deadlineTo)!);
  if (f.noticeTypes.length === 1) base.ptype = f.noticeTypes[0];
  else if (f.noticeTypes.length > 1) localFilters.push(`Notice types (${f.noticeTypes.length} selected; SAM accepts one per request)`);
  if (f.setAside.length === 1) base.typeOfSetAside = f.setAside[0];
  else if (f.setAside.length > 1) localFilters.push(`Set-asides (${f.setAside.length} selected)`);
  if (f.states.length === 1) base.state = f.states[0].toUpperCase();
  else if (f.states.length > 1) localFilters.push(`Place-of-performance states (${f.states.length} selected)`);
  if (f.keywords.length) localFilters.push(`Keywords in the title: ${f.keywords.join(', ')} (SAM has no keyword search)`);

  const naics = [...new Set(f.naics)];
  const calls = naics.length ? naics.map((n) => ({ ...base, ncode: n })) : [{ ...base }];
  if (naics.length > 1) warnings.push(`SAM accepts one NAICS per request, so this search makes ${naics.length} requests; results are de-duplicated by notice ID.`);
  const narrowing = naics.length || base.title || base.ccode || base.organizationName || base.solnum || base.noticeid || base.ptype || base.typeOfSetAside || base.state;
  let blocked: string | null = null;
  if (!narrowing) blocked = 'Add at least one SAM filter (NAICS, title phrase, PSC, agency, set-aside, state, notice type or an identifier). Broad discovery is handled by the free bulk file.';
  else if (calls.length > maxRequests) blocked = `This search needs ${calls.length} SAM requests (one per NAICS code) but the limit for one search is ${maxRequests}. Remove some NAICS codes or raise the limit.`;
  return { calls, estimatedRequests: calls.length, maxRequests, localFilters, warnings, blocked };
}

/** Local filters applied to live results (for multi-value filters SAM cannot express). */
export function keepLiveItem(item: any, f: TargetedFilters): boolean {
  if (f.noticeTypes.length > 1) {
    const labels = SAM_NOTICE_TYPES.filter((t) => f.noticeTypes.includes(t.code)).map((t) => t.label.toLowerCase());
    const type = String(item.type ?? item.baseType ?? '').toLowerCase();
    if (!labels.some((l) => type === l || type.startsWith(l))) return false;
  }
  if (f.setAside.length > 1 && !f.setAside.includes(String(item.typeOfSetAside ?? ''))) return false;
  if (f.states.length > 1) {
    const st = String(item.placeOfPerformance?.state?.code ?? item.placeOfPerformance?.state ?? '').toUpperCase();
    if (!f.states.map((s) => s.toUpperCase()).includes(st)) return false;
  }
  if (f.keywords.length) {
    const title = String(item.title ?? '').toLowerCase();
    if (!f.keywords.some((k) => title.includes(k.toLowerCase()))) return false;
  }
  return true;
}

/** Search GovCheck's own database. Never contacts any external source. */
export async function searchLocal(db: Db, f: TargetedFilters, limit = 200): Promise<{ total: number; results: any[] }> {
  const where: string[] = ['o.merged_into_id IS NULL'];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.naics.length) where.push(`(o.naics_code LIKE ANY(${p(f.naics.map((n) => `${n}%`))}::text[]) OR EXISTS (SELECT 1 FROM unnest(o.naics_codes) nc WHERE nc LIKE ANY($${params.length}::text[])))`);
  const words = [...(f.titlePhrase ? [f.titlePhrase] : []), ...f.keywords];
  if (words.length) {
    const ors = words.map((w) => `(o.title ILIKE ${p(`%${w}%`)} OR o.search_vector @@ plainto_tsquery('english', ${p(w)}))`);
    where.push(`(${ors.join(' OR ')})`);
  }
  if (f.psc) where.push(`o.psc_code ILIKE ${p(`${f.psc}%`)}`);
  if (f.organization) where.push(`(o.department_name ILIKE ${p(`%${f.organization}%`)} OR o.subtier_name ILIKE $${params.length} OR o.office_name ILIKE $${params.length})`);
  if (f.setAside.length) where.push(`o.set_aside_code = ANY(${p(f.setAside)}::text[])`);
  if (f.states.length) where.push(`upper(o.place_state) = ANY(${p(f.states.map((s) => s.toUpperCase()))}::text[])`);
  if (f.noticeTypes.length) {
    const labels = SAM_NOTICE_TYPES.filter((t) => f.noticeTypes.includes(t.code)).map((t) => `${t.label}%`);
    where.push(`o.notice_type ILIKE ANY(${p(labels)}::text[])`);
  }
  if (f.solicitationNumber) where.push(`EXISTS (SELECT 1 FROM opportunity_identifiers i WHERE i.opportunity_id = o.id AND i.id_type = 'solicitation_number' AND i.normalized_value = ${p(normalizeIdentifier('solicitation_number', f.solicitationNumber) ?? '')})`);
  if (f.noticeId) where.push(`EXISTS (SELECT 1 FROM opportunity_identifiers i WHERE i.opportunity_id = o.id AND i.id_type = 'notice_id' AND i.normalized_value = ${p(f.noticeId.trim().toUpperCase())})`);
  if (f.postedFrom) where.push(`o.posted_at >= ${p(f.postedFrom)}::date`);
  if (f.postedTo) where.push(`o.posted_at < (${p(f.postedTo)}::date + 1)`);
  if (f.deadlineFrom) where.push(`o.response_deadline >= ${p(f.deadlineFrom)}::date`);
  if (f.deadlineTo) where.push(`o.response_deadline < (${p(f.deadlineTo)}::date + 1)`);
  const sql = where.join(' AND ');
  const total = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM opportunities o WHERE ${sql}`, params);
  const results = await db.query(
    `SELECT o.id, o.title, o.stage, o.status, o.notice_type, o.solicitation_number, o.department_name, o.subtier_name, o.naics_code, o.psc_code, o.set_aside_code, o.set_aside,
       o.place_state, o.posted_at, o.response_deadline, o.fit_score, o.priority_score, o.is_signal, o.connector_ids,
       (SELECT d.decision FROM user_opportunity_decisions d WHERE d.opportunity_id = o.id AND d.is_current LIMIT 1) AS decision
     FROM opportunities o WHERE ${sql} ORDER BY o.fit_score DESC NULLS LAST, o.response_deadline ASC NULLS LAST LIMIT ${Math.max(1, Math.min(500, limit))}`,
    params,
  );
  return { total: total?.n ?? 0, results };
}

export interface LiveSearchResult {
  searchId: string;
  status: 'success' | 'partial' | 'failed';
  requestsUsed: number;
  returned: number;
  kept: number;
  newRecords: number;
  changedRecords: number;
  truncated: boolean;
  message: string;
  opportunities: any[];
}

export class LiveSearchRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 429 = 400,
  ) {
    super(message);
  }
}

/** Execute a confirmed live SAM search and ingest the results. */
export async function executeLiveSearch(deps: SyncDeps, f: TargetedFilters, opts: { maxRequests?: number; confirm: boolean; triggeredBy?: string }): Promise<LiveSearchResult> {
  const { db, config } = deps;
  if (!opts.confirm) throw new LiveSearchRefused('A live SAM.gov search must be explicitly confirmed (confirm: true).');
  if (!config.samApiKey) throw new LiveSearchRefused('SAM_API_KEY is not configured on the server.');
  const maxRequests = Math.max(1, Math.min(opts.maxRequests ?? config.samTargetedSearchMaxRequests, config.samDailyRequestLimit));
  const plan = planLiveSearch(f, maxRequests);
  if (plan.blocked) throw new LiveSearchRefused(plan.blocked);
  const remaining = await deps.budget.remaining(SAM_BUDGET_KEY);
  if (remaining < plan.estimatedRequests)
    throw new LiveSearchRefused(`This search needs ${plan.estimatedRequests} SAM request(s) but only ${remaining} remain today. GovCheck's counter resets at 00:00 UTC.`, 429);

  const runId = await startRun(db, 'sam_opportunities', 'targeted_search', opts.triggeredBy ?? 'manual', { filters: f }, {});
  const budget = withBudgetMeta(deps.budget, { category: 'targeted_search', connectorId: 'sam_opportunities', detail: { searchRunId: runId } });
  const ctx = { budget, http: deps.http, config };
  const byNotice = new Map<string, any>();
  let requestsUsed = 0;
  let returned = 0;
  let truncated = false;
  const notes: string[] = [...plan.warnings];
  let failed: string | null = null;
  const started = Date.now();

  try {
    for (const call of plan.calls) {
      let offset = 0;
      for (;;) {
        if (requestsUsed >= maxRequests) {
          truncated = true;
          break;
        }
        const data = await samSearch(ctx, { ...call, offset });
        requestsUsed++;
        const items: any[] = Array.isArray(data.opportunitiesData) ? data.opportunitiesData : [];
        returned += items.length;
        for (const it of items) if (it?.noticeId && !byNotice.has(String(it.noticeId))) byNotice.set(String(it.noticeId), it);
        const total = Number(data.totalRecords ?? 0);
        offset += items.length;
        if (!items.length || offset >= total) break;
        // More pages exist; continue only while the per-search limit allows.
        if (requestsUsed >= maxRequests) {
          truncated = true;
          notes.push(`SAM reported ${total.toLocaleString()} matches for ${call.ncode ? `NAICS ${call.ncode}` : 'this search'}; only the first ${offset.toLocaleString()} were retrieved. Narrow the filters to see the rest.`);
          break;
        }
      }
    }
  } catch (err) {
    failed = err instanceof BudgetExhaustedError ? err.message : errorMessage(err);
    await logSyncError(db, runId, 'sam_opportunities', 'fetch', failed, null, { filters: f }, false);
  }

  const kept = [...byNotice.values()].filter((it) => keepLiveItem(it, f));
  const records = toRecords(kept);
  const stats = emptyStats();
  stats.retrieved = records.length;
  const ictx: IngestContext = {
    db,
    connectorId: 'sam_opportunities',
    connectorName: 'SAM.gov Contract Opportunities (API)',
    adapter: samOpportunitiesAdapter,
    priorities: await connectorPriorities(db),
    log: deps.log.child('targeted-search'),
    dirty: new Set(),
    stats,
  };
  for (const rec of records) {
    try {
      const r = await ingestRecord(ictx, rec);
      if (r === 'new') stats.created++;
      else if (r === 'changed') stats.updated++;
      else stats.unchanged++;
    } catch (err) {
      stats.failed++;
      await logSyncError(db, runId, 'sam_opportunities', 'normalize', errorMessage(err), rec.sourceRecordId);
    }
  }
  const dirty = [...ictx.dirty];
  for (const id of dirty) await extractDescriptionRequirements(db, id).catch(() => undefined);
  if (dirty.length) await scoreMany(db, dirty, 'targeted search');

  const status: LiveSearchResult['status'] = failed ? (records.length ? 'partial' : 'failed') : stats.failed ? 'partial' : 'success';
  const message = [
    `${requestsUsed} SAM request(s) · ${returned} result(s) returned · ${records.length} kept after local filters · ${stats.created} new / ${stats.updated} changed / ${stats.unchanged} already current`,
    failed ? `Error: ${failed}` : null,
    ...notes,
  ]
    .filter(Boolean)
    .join(' · ');
  await db.query(
    `UPDATE sync_runs SET status = $2, finished_at = now(), duration_ms = $3, message = $4, records_retrieved = $5, records_created = $6, records_updated = $7, records_unchanged = $8,
       records_failed = $9, opportunities_created = $10, opportunities_updated = $11, api_requests = $12 WHERE id = $1`,
    [runId, status === 'success' ? 'success' : status === 'partial' ? 'partial_success' : 'failed', Date.now() - started, message.slice(0, 2000), returned, stats.created, stats.updated, stats.unchanged, stats.failed, stats.opportunitiesCreated, stats.opportunitiesUpdated, requestsUsed],
  );

  const oppIds = records.length
    ? (
        await db.query<{ opportunity_id: string }>(
          `SELECT DISTINCT os.opportunity_id FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id
           WHERE sr.connector_id = 'sam_opportunities' AND sr.source_record_id = ANY($1::text[])`,
          [records.map((r) => r.sourceRecordId)],
        )
      ).map((r) => r.opportunity_id)
    : [];
  const search = await db.one<{ id: string }>(
    `INSERT INTO targeted_searches (filters, sam_params, status, requests_used, requests_planned, results_returned, results_kept, records_new, records_changed, notice_ids, opportunity_ids, message, sync_run_id)
     VALUES ($1::jsonb,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::uuid[],$12,$13) RETURNING id`,
    [json(f), json(plan.calls), status, requestsUsed, plan.estimatedRequests, returned, records.length, stats.created, stats.updated, records.map((r) => r.sourceRecordId), oppIds, message.slice(0, 2000), runId],
  );
  const opportunities = oppIds.length
    ? await db.query(
        `SELECT o.id, o.title, o.stage, o.status, o.notice_type, o.solicitation_number, o.department_name, o.naics_code, o.set_aside_code, o.place_state, o.posted_at, o.response_deadline, o.fit_score, o.priority_score, o.is_signal,
           o.first_seen_at > now() - interval '10 minutes' AS is_new
         FROM opportunities o WHERE o.id = ANY($1::uuid[]) AND o.merged_into_id IS NULL ORDER BY o.fit_score DESC NULLS LAST`,
        [oppIds],
      )
    : [];
  return { searchId: search!.id, status, requestsUsed, returned, kept: records.length, newRecords: stats.created, changedRecords: stats.updated, truncated, message, opportunities };
}
