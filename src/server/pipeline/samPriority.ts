import type { Db } from '../db';
import type { AppConfig } from '../config';
import { connectorPriorities } from '../connectors/registry';
import { fetchSamDescription, SAM_BUDGET_KEY, samOpportunitiesAdapter, samSearch, toRecords } from '../connectors/sam/samOpportunities';
import type { RequestBudget } from '../connectors/types';
import { addDays, toSamDate } from '../lib/dates';
import { errorMessage } from '../lib/logger';
import { BudgetExhaustedError, SAM_CATEGORIES, withBudgetMeta, type SamCategory } from './budget';
import { emptyStats, ingestRecord, type IngestContext } from './ingest';
import { recordHash } from './store';
import { logSyncError, startRun, type SyncDeps } from './sync';

/**
 * SAM.gov request priority model.
 *
 * Personal SAM API keys allow very few requests per day, so scheduled work spends them
 * top-down and stops when the background allowance (daily limit − interactive reserve)
 * is gone:
 *
 *   1. tracked         Opportunities someone marked Pursue / Interested / Watch, or that are
 *                      in an active capture stage — checked for amendments and new documents.
 *   2. active_changes  Relevant active opportunities closing within 21 days whose SAM data is
 *                      older than two days.
 *   3. stale_high_fit  Strong matches (fit ≥ SAM_PRIORITY_MIN_FIT) whose SAM data is older than
 *                      SAM_STALE_DAYS.
 *   4. new_match       Strong matches discovered this week from the free bulk file that have
 *                      never been fetched live (adds attachment links and contacts).
 *   (5. targeted_search — interactive, see targetedSearch.ts)
 *   6. discovery       The general "new notices" feed (sam_opportunities incremental), which
 *                      runs only with whatever budget is left afterwards.
 *
 * Breadth comes from the free bulk extract; the daily bulk reconciliation also refreshes
 * "last seen" for every tracked notice at no API cost, which keeps tiers 2–3 small.
 */

export interface SamCheckCandidate {
  opportunityId: string;
  title: string;
  category: SamCategory;
  reason: string;
  noticeId: string | null;
  solicitationNumber: string | null;
  postedAt: string | null;
  fit: number | null;
  lastLiveCheck: string | null;
  lastSamSeen: string | null;
  estimatedRequests: number;
}

export interface SamPriorityPlan {
  limit: number;
  used: number;
  remaining: number;
  reserve: number;
  backgroundAvailable: number;
  tiers: { category: SamCategory; label: string; candidates: SamCheckCandidate[] }[];
  /** Candidates that today's background allowance covers, in the order they will run. */
  willRunToday: number;
}

const TRACKED_DECISIONS = ['pursue', 'interested', 'watch'];
const ACTIVE_CAPTURE_STAGES = ['reviewing', 'qualified', 'capture', 'bid_decision', 'proposal', 'submitted'];

/** Common projection: SAM identifiers and freshness for each live, non-merged prime opportunity. */
const BASE = `
  SELECT o.id AS opportunity_id, o.title, o.fit_score AS fit, o.status, o.response_deadline, o.first_seen_at,
    COALESCE(o.primary_notice_id, (SELECT i.value FROM opportunity_identifiers i WHERE i.opportunity_id = o.id AND i.id_type = 'notice_id' ORDER BY i.created_at LIMIT 1)) AS notice_id,
    o.solicitation_number, o.posted_at,
    GREATEST(o.sam_live_checked_at, (SELECT max(sr.retrieved_at) FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id WHERE os.opportunity_id = o.id AND sr.connector_id = 'sam_opportunities')) AS last_live_check,
    GREATEST(o.sam_live_checked_at, (SELECT max(sr.last_seen_at) FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id WHERE os.opportunity_id = o.id AND sr.connector_id IN ('sam_opportunities','sam_bulk'))) AS last_sam_seen
  FROM opportunities o
  WHERE o.merged_into_id IS NULL AND o.opportunity_class = 'prime'
    AND o.connector_ids && ARRAY['sam_opportunities','sam_bulk']::text[]`;

function toCandidate(r: any, category: SamCategory, reason: string, withDescription: boolean): SamCheckCandidate {
  return {
    opportunityId: r.opportunity_id,
    title: r.title,
    category,
    reason,
    noticeId: r.notice_id ?? null,
    solicitationNumber: r.solicitation_number ?? null,
    postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null,
    fit: r.fit ?? null,
    lastLiveCheck: r.last_live_check ? new Date(r.last_live_check).toISOString() : null,
    lastSamSeen: r.last_sam_seen ? new Date(r.last_sam_seen).toISOString() : null,
    // One search request; tracked items may need one more for a changed description.
    estimatedRequests: withDescription ? 2 : 1,
  };
}

/** Build the prioritized list of live checks. Read-only; never spends a request. */
export async function planSamPriorityWork(db: Db, config: AppConfig, opts: { perTierLimit?: number } = {}): Promise<SamCheckCandidate[][]> {
  const limit = opts.perTierLimit ?? 50;
  const trackedHours = config.samTrackedRefreshHours;
  const minFit = config.samPriorityMinFit;

  const tracked = await db.query<any>(
    `SELECT * FROM (${BASE}
       AND (EXISTS (SELECT 1 FROM user_opportunity_decisions d WHERE d.opportunity_id = o.id AND d.is_current AND d.decision = ANY($1::text[]))
            OR EXISTS (SELECT 1 FROM opportunity_capture k WHERE k.opportunity_id = o.id AND k.pursuit_stage = ANY($2::text[])))
       AND (o.status NOT IN ('cancelled','archived','awarded') OR EXISTS (SELECT 1 FROM opportunity_capture k WHERE k.opportunity_id = o.id AND k.pursuit_stage = 'submitted'))
     ) x WHERE x.last_live_check IS NULL OR x.last_live_check < now() - ($3::int * interval '1 hour')
     ORDER BY x.response_deadline ASC NULLS LAST LIMIT $4`,
    [TRACKED_DECISIONS, ACTIVE_CAPTURE_STAGES, trackedHours, limit],
  );
  const active = await db.query<any>(
    `SELECT * FROM (${BASE} AND o.status = 'active' AND o.response_deadline BETWEEN now() AND now() + interval '21 days' AND COALESCE(o.fit_score, 0) >= $1) x
     WHERE x.last_sam_seen IS NULL OR x.last_sam_seen < now() - interval '48 hours'
     ORDER BY x.response_deadline ASC LIMIT $2`,
    [Math.max(0, minFit - 15), limit],
  );
  const stale = await db.query<any>(
    `SELECT * FROM (${BASE} AND o.status IN ('active','forecast','unknown') AND COALESCE(o.fit_score, 0) >= $1) x
     WHERE x.last_sam_seen IS NULL OR x.last_sam_seen < now() - ($2::int * interval '1 day')
     ORDER BY x.fit DESC NULLS LAST LIMIT $3`,
    [minFit, config.samStaleDays, limit],
  );
  const fresh = await db.query<any>(
    `SELECT * FROM (${BASE} AND o.status = 'active' AND COALESCE(o.fit_score, 0) >= $1 AND o.first_seen_at > now() - interval '7 days') x
     WHERE x.last_live_check IS NULL
     ORDER BY x.fit DESC NULLS LAST LIMIT $2`,
    [minFit, limit],
  );

  const seen = new Set<string>();
  const usable = (r: any) => (r.notice_id || r.solicitation_number) && !seen.has(r.opportunity_id) && (seen.add(r.opportunity_id), true);
  return [
    tracked.filter(usable).map((r) => toCandidate(r, 'tracked', 'Marked Pursue / Interested / Watch or in an active capture stage', true)),
    active.filter(usable).map((r) => toCandidate(r, 'active_changes', 'Relevant, closes within 21 days, SAM data older than 2 days', false)),
    stale.filter(usable).map((r) => toCandidate(r, 'stale_high_fit', `Strong match (fit ≥ ${minFit}) with SAM data older than ${config.samStaleDays} days`, false)),
    fresh.filter(usable).map((r) => toCandidate(r, 'new_match', 'New strong match from the bulk file, never fetched live', false)),
  ];
}

/** Plan + today's budget, for the Sources page. */
export async function samPriorityOverview(db: Db, config: AppConfig): Promise<SamPriorityPlan> {
  const tiers = await planSamPriorityWork(db, config);
  const usedRow = await db.one<{ requests: number }>(`SELECT requests FROM api_usage WHERE connector_id = 'sam' AND usage_date = $1`, [new Date().toISOString().slice(0, 10)]);
  const used = usedRow?.requests ?? 0;
  const remaining = Math.max(0, config.samDailyRequestLimit - used);
  const backgroundAvailable = Math.max(0, remaining - config.samManualReserve);
  // Each check costs at least one request, so the allowance bounds how many run today.
  const willRun = Math.min(backgroundAvailable, tiers.flat().length);
  const label = (id: string) => SAM_CATEGORIES.find((c) => c.id === id)?.label ?? id;
  const order: SamCategory[] = ['tracked', 'active_changes', 'stale_high_fit', 'new_match'];
  return {
    limit: config.samDailyRequestLimit,
    used,
    remaining,
    reserve: config.samManualReserve,
    backgroundAvailable,
    tiers: order.map((category, i) => ({ category, label: label(category), candidates: tiers[i] })),
    willRunToday: willRun,
  };
}

/** SAM search parameters for a live check of one opportunity. */
export function liveCheckParams(c: Pick<SamCheckCandidate, 'noticeId' | 'solicitationNumber' | 'postedAt'>, now = new Date()): Record<string, string | number> {
  const earliest = addDays(now, -364);
  const posted = c.postedAt ? new Date(c.postedAt) : null;
  const from = posted && posted > earliest ? addDays(posted, -2) : earliest;
  const params: Record<string, string | number> = { postedFrom: toSamDate(from < earliest ? earliest : from), postedTo: toSamDate(now), limit: 100, offset: 0 };
  // The solicitation number finds amendments re-posted under new notice IDs.
  if (c.solicitationNumber) params.solnum = c.solicitationNumber;
  else if (c.noticeId) params.noticeid = c.noticeId;
  return params;
}

export interface PriorityRunResult {
  runId: string | null;
  checked: number;
  requests: number;
  newRecords: number;
  changedRecords: number;
  byCategory: Record<string, number>;
  dirty: string[];
  message: string;
}

/**
 * Execute tiers 1–4 within the background allowance. Results go through the normal
 * ingestion pipeline (source_records + versions + events), never around it.
 */
export async function runSamPriorityChecks(deps: SyncDeps, opts: { triggeredBy: string; budget?: RequestBudget; maxRequests?: number } = { triggeredBy: 'schedule' }): Promise<PriorityRunResult> {
  const { db, config, log } = deps;
  const empty = (message: string): PriorityRunResult => ({ runId: null, checked: 0, requests: 0, newRecords: 0, changedRecords: 0, byCategory: {}, dirty: [], message });
  if (!config.samApiKey) return empty('SAM_API_KEY is not set.');
  const row = await db.one<{ enabled: boolean }>(`SELECT enabled FROM source_connectors WHERE id = 'sam_opportunities'`);
  if (!row?.enabled) return empty('SAM.gov Contract Opportunities connector is disabled.');

  const budget = opts.budget ?? deps.budget;
  const reserve = config.samManualReserve;
  let requests = 0;
  /** Requests this run may still make: background allowance, capped by maxRequests. */
  const allowance = async () => Math.min((opts.maxRequests ?? Number.POSITIVE_INFINITY) - requests, (await budget.remaining(SAM_BUDGET_KEY)) - reserve);
  if ((await allowance()) < 1) return empty(`No background SAM requests left today (${reserve} kept in reserve for manual refreshes and targeted searches).`);

  const tiers = (await planSamPriorityWork(db, config)).flat();
  if (!tiers.length) return empty('No tracked or high-priority opportunities need a live check.');

  const runId = await startRun(db, 'sam_opportunities', 'priority', opts.triggeredBy, { tiers: [...new Set(tiers.map((t) => t.category))] }, {});
  const stats = emptyStats();
  const ictx: IngestContext = {
    db,
    connectorId: 'sam_opportunities',
    connectorName: 'SAM.gov Contract Opportunities (API)',
    adapter: samOpportunitiesAdapter,
    priorities: await connectorPriorities(db),
    log: log.child('sam-priority'),
    dirty: new Set(),
    stats,
  };
  const byCategory: Record<string, number> = {};
  let checked = 0;
  const notes: string[] = [];
  const started = Date.now();
  let processed = 0;

  for (const c of tiers) {
    if ((await allowance()) < 1) {
      notes.push('Background allowance used up; remaining checks continue on the next run.');
      break;
    }
    const tagged = withBudgetMeta(budget, { category: c.category, connectorId: 'sam_opportunities', detail: { opportunityId: c.opportunityId } });
    const ctx = { budget: tagged, http: deps.http, config };
    try {
      const data = await samSearch(ctx, liveCheckParams(c));
      requests++;
      byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
      checked++;
      const records = toRecords(Array.isArray(data.opportunitiesData) ? data.opportunitiesData : []);
      stats.retrieved += records.length;
      for (const rec of records) {
        // Tracked opportunities: when the notice is new or changed, also fetch its full
        // description (one more request) if the background allowance still covers it.
        if (c.category === 'tracked') {
          const existing = await db.one<{ content_hash: string; raw_text: string | null }>(
            `SELECT content_hash, raw_text FROM source_records WHERE connector_id = 'sam_opportunities' AND source_record_id = $1`,
            [rec.sourceRecordId],
          );
          const changed = !existing || existing.content_hash !== recordHash(rec, existing.raw_text);
          const descUrl = (rec.raw as any)?.description;
          if (changed && typeof descUrl === 'string' && /^https?:/i.test(descUrl) && (await allowance()) >= 1) {
            try {
              const text = await fetchSamDescription(ctx, descUrl);
              requests++;
              byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
              if (text) rec.rawText = text;
            } catch (err) {
              if (err instanceof BudgetExhaustedError) throw err;
              log.warn('Could not fetch SAM description', err);
            }
          }
        }
        try {
          const r = await ingestRecord(ictx, rec);
          processed++;
          if (r === 'new') stats.created++;
          else if (r === 'changed') stats.updated++;
          else stats.unchanged++;
        } catch (err) {
          stats.failed++;
          await logSyncError(db, runId, 'sam_opportunities', 'normalize', errorMessage(err), rec.sourceRecordId);
        }
      }
      // Remember that we looked (even when SAM returned nothing, e.g. a withdrawn notice) so the
      // same opportunity is not re-checked on every run.
      if (!records.length) notes.push(`No SAM result for ${c.solicitationNumber ?? c.noticeId}`);
      await db.query('UPDATE opportunities SET sam_live_checked_at = now() WHERE id = $1', [c.opportunityId]);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        notes.push(err.message);
        break;
      }
      stats.failed++;
      await logSyncError(db, runId, 'sam_opportunities', 'fetch', errorMessage(err), c.noticeId ?? c.solicitationNumber, { category: c.category }, true);
    }
  }

  const summary = Object.entries(byCategory)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  const message = [`${checked} live check(s), ${requests} SAM request(s)${summary ? ` (${summary})` : ''} · ${stats.created} new / ${stats.updated} changed / ${stats.unchanged} unchanged records`, ...notes.slice(0, 4)].join(' · ');
  const status = stats.failed ? (processed ? 'partial_success' : 'failed') : 'success';
  await db.query(
    `UPDATE sync_runs SET status = $2, finished_at = now(), duration_ms = $3, message = $4, records_retrieved = $5, records_created = $6, records_updated = $7, records_unchanged = $8,
       records_failed = $9, opportunities_created = $10, opportunities_updated = $11, api_requests = $12 WHERE id = $1`,
    [runId, status, Date.now() - started, message.slice(0, 2000), stats.retrieved, stats.created, stats.updated, stats.unchanged, stats.failed, stats.opportunitiesCreated, stats.opportunitiesUpdated, requests],
  );
  return { runId, checked, requests, newRecords: stats.created, changedRecords: stats.updated, byCategory, dirty: [...ictx.dirty], message };
}
