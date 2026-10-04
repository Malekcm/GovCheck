import type { AppConfig } from '../config';
import type { Db } from '../db';
import { json } from '../db';
import { analyzeOpportunity, createAiProvider } from '../ai/analyze';
import { connectorPriorities, getAdapter, listAdapters, type ConnectorRow } from '../connectors/registry';
import type { ConnectorContext, RequestBudget, SourceAdapter, SyncMode } from '../connectors/types';
import type { HttpClient } from '../lib/http';
import type { Logger } from '../lib/logger';
import { errorMessage } from '../lib/logger';
import type { IdentifierType } from '../lib/ids';
import { loadCompanyContext } from '../scoring/profile';
import { prepareScoring, scoreMany } from '../scoring/run';
import { BudgetExhaustedError, withBudgetMeta } from './budget';
import { acquireLease, currentLease, releaseLease, renewLease, SYNC_LEASE_TTL_MS } from './lease';
import { recomputeOpportunity } from './canonical';
import { computeCoverage } from './coverage';
import { extractDescriptionRequirements, processPendingDocuments } from './documents';
import { analyzeIncumbency, fetchRelatedAwards } from './enrich';
import { emptyStats, ingestRecord, markUnseen, type IngestContext } from './ingest';
import { runRecompeteEngine } from './recompete';
import { partitionUnchanged } from './store';
import { discoveryTerms } from './searchTerms';
import { runSamPriorityChecks } from './samPriority';

export interface SyncDeps {
  db: Db;
  config: AppConfig;
  http: HttpClient;
  log: Logger;
  budget: RequestBudget;
}

export interface RunSummary {
  runId: string;
  connectorId: string;
  status: 'success' | 'partial_success' | 'failed' | 'skipped';
  message: string;
  dirty: string[];
  stats: ReturnType<typeof emptyStats>;
}

/** Connectors whose incremental run lists everything currently active (so absence is meaningful). */
const FULL_LISTING_CONNECTORS = new Set(['sba_subnet', 'grants_gov', 'dhs_apfs']);

export async function focusFor(db: Db): Promise<ConnectorContext['focus']> {
  const co = await loadCompanyContext(db);
  return {
    naics: co.naics,
    psc: co.psc,
    keywords: co.keywords,
    includeGrants: co.includeGrants,
    terms: discoveryTerms(co),
    negativeKeywords: co.negativeKeywords,
    preferredAgencies: co.preferredAgencies,
  };
}

/** Budget category for requests a connector makes during a normal run. */
export function budgetCategoryFor(connectorId: string): string {
  if (connectorId === 'sam_opportunities') return 'discovery';
  if (connectorId === 'sam_awards') return 'awards';
  return 'other';
}

export async function startRun(db: Db, connectorId: string, mode: string, triggeredBy: string, params: Record<string, unknown>, cursor: unknown): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO sync_runs (connector_id, mode, status, triggered_by, params, started_at, cursor_before) VALUES ($1,$2,'running',$3,$4::jsonb, now(), $5::jsonb) RETURNING id`,
    [connectorId, mode, triggeredBy, json(params), json(cursor ?? {})],
  );
  await db.query('UPDATE source_connectors SET last_attempted_at = now(), last_run_id = $2 WHERE id = $1', [connectorId, row!.id]);
  return row!.id;
}

export async function logSyncError(db: Db, runId: string | null, connectorId: string | null, step: string, message: string, recordRef?: string | null, detail?: unknown, retryable = false): Promise<void> {
  await db.query(`INSERT INTO sync_errors (sync_run_id, connector_id, step, record_ref, message, detail, retryable) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [
    runId,
    connectorId,
    step,
    recordRef ?? null,
    message.slice(0, 2000),
    json(detail ?? null),
    retryable,
  ]);
}

/**
 * Run one connector. Failures are isolated: a broken source marks itself Error/Degraded
 * and never prevents other connectors from syncing.
 */
export async function runConnector(
  deps: SyncDeps,
  connectorId: string,
  opts: { mode?: SyncMode; triggeredBy?: string; params?: Record<string, unknown>; timeLimitMs?: number; maxChanged?: number; budgetCategory?: string } = {},
): Promise<RunSummary> {
  const { db, log } = deps;
  const mode = opts.mode ?? 'incremental';
  const row = await db.one<ConnectorRow>('SELECT * FROM source_connectors WHERE id = $1', [connectorId]);
  const adapter = await getAdapter(db, connectorId);
  const stats = emptyStats();
  if (!row || !adapter) throw new Error(`Unknown connector ${connectorId}`);

  const skip = async (message: string, health?: string): Promise<RunSummary> => {
    const runId = await startRun(db, connectorId, mode, opts.triggeredBy ?? 'manual', opts.params ?? {}, row.cursor);
    await db.query(`UPDATE sync_runs SET status = 'skipped', finished_at = now(), duration_ms = 0, message = $2 WHERE id = $1`, [runId, message]);
    if (health) await db.query('UPDATE source_connectors SET health = $2, health_message = $3, updated_at = now() WHERE id = $1', [connectorId, health, message]);
    return { runId, connectorId, status: 'skipped', message, dirty: [], stats };
  };
  if (!row.enabled) return skip('Connector is disabled.');
  const configured = adapter.isConfigured(deps.config);
  if (!configured.configured) return skip(configured.reason ?? 'Not configured.', 'not_configured');
  if (mode === 'reconcile' && !adapter.fetchReconcile) return skip('This source has no separate reconciliation mode.');

  const runId = await startRun(db, connectorId, mode, opts.triggeredBy ?? 'manual', opts.params ?? {}, row.cursor);
  const started = Date.now();
  const deadline = started + (opts.timeLimitMs ?? 45 * 60_000);
  const maxChanged = opts.maxChanged ?? (connectorId === 'sam_bulk' ? deps.config.samBulkMaxRecordsPerRun : Number.POSITIVE_INFINITY);
  const ictx: IngestContext = {
    db,
    connectorId,
    connectorName: row.name,
    adapter,
    priorities: await connectorPriorities(db),
    log: log.child(connectorId),
    dirty: new Set(),
    stats,
  };
  const ctx: ConnectorContext = {
    db,
    http: deps.http,
    config: deps.config,
    log: log.child(connectorId),
    budget: withBudgetMeta(deps.budget, { category: opts.budgetCategory ?? budgetCategoryFor(connectorId), connectorId }),
    settings: row.config ?? {},
    focus: await focusFor(db),
    shouldStop: () => Date.now() > deadline || stats.created + stats.updated >= maxChanged,
    params: opts.params ?? {},
  };

  let cursor: Record<string, unknown> = row.cursor ?? {};
  const notes: string[] = [];
  let apiRequests = 0;
  let fatal: string | null = null;
  let budgetHit = false;
  const warnings: string[] = [];
  const flush = async () => {
    await db.query(
      `UPDATE sync_runs SET records_retrieved = $2, records_created = $3, records_updated = $4, records_unchanged = $5, records_failed = $6,
         opportunities_created = $7, opportunities_updated = $8, api_requests = $9 WHERE id = $1`,
      [runId, stats.retrieved, stats.created, stats.updated, stats.unchanged, stats.failed, stats.opportunitiesCreated, stats.opportunitiesUpdated, apiRequests],
    );
  };

  try {
    const pages = mode === 'reconcile' ? adapter.fetchReconcile!(ctx, cursor) : adapter.fetchIncremental(ctx, cursor);
    for await (const page of pages) {
      apiRequests += page.apiRequests ?? 0;
      if (page.note) notes.push(page.note);
      if (page.warning) {
        warnings.push(page.warning);
        await logSyncError(db, runId, connectorId, 'coverage', page.warning, null, null, false);
      }
      stats.retrieved += page.records.length;
      let toProcess = page.records;
      if (page.records.length > 50) {
        const part = await partitionUnchanged(db, connectorId, page.records, adapter.parserVersion);
        stats.unchanged += part.unchanged;
        toProcess = part.changed;
      }
      for (const rec of toProcess) {
        if (ctx.shouldStop()) break;
        try {
          const r = await ingestRecord(ictx, rec);
          if (r === 'new') stats.created++;
          else if (r === 'changed') stats.updated++;
          else stats.unchanged++;
        } catch (err) {
          stats.failed++;
          await logSyncError(db, runId, connectorId, 'normalize', errorMessage(err), rec.sourceRecordId);
        }
      }
      if (page.cursor) {
        cursor = page.cursor;
        await db.query('UPDATE source_connectors SET cursor = $2::jsonb WHERE id = $1', [connectorId, json(cursor)]);
      }
      await flush();
      if (ctx.shouldStop()) {
        notes.push(Date.now() > deadline ? 'Stopped at the time limit; the next run resumes from the saved cursor.' : `Stopped after ${maxChanged} new/changed records for this run; the next run continues.`);
        break;
      }
    }
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      budgetHit = true;
      notes.push(err.message);
    } else {
      fatal = errorMessage(err);
      await logSyncError(db, runId, connectorId, 'fetch', fatal, null, null, true);
      log.warn(`${connectorId} fetch failed: ${fatal}`);
    }
  }

  const processed = stats.created + stats.updated + stats.unchanged;
  const status: RunSummary['status'] = fatal ? (processed > 0 ? 'partial_success' : 'failed') : stats.failed > 0 || budgetHit || warnings.length ? 'partial_success' : 'success';
  if (status === 'success' && mode === 'incremental' && FULL_LISTING_CONNECTORS.has(connectorId) && stats.retrieved > 0) {
    await markUnseen(db, connectorId, new Date(started));
  }
  const message = [fatal ? `Error: ${fatal}` : null, ...warnings.slice(0, 3).map((w) => `Coverage warning: ${w}`), ...notes.slice(-4)].filter(Boolean).join(' · ') || 'Completed.';
  await flush();
  await db.query(`UPDATE sync_runs SET status = $2, finished_at = now(), duration_ms = $3, message = $4, cursor_after = $5::jsonb WHERE id = $1`, [runId, status, Date.now() - started, message.slice(0, 2000), json(cursor)]);
  const health = status === 'success' ? 'healthy' : status === 'partial_success' ? 'degraded' : 'error';
  await db.query(
    `UPDATE source_connectors SET health = $2, health_message = $3, records_retrieved_total = records_retrieved_total + $4,
       last_success_at = CASE WHEN $5 THEN now() ELSE last_success_at END,
       next_run_at = CASE WHEN schedule_minutes IS NOT NULL THEN now() + (schedule_minutes * interval '1 minute') ELSE next_run_at END, updated_at = now()
     WHERE id = $1`,
    [connectorId, health, message.slice(0, 500), stats.retrieved, status !== 'failed'],
  );
  return { runId, connectorId, status, message, dirty: [...ictx.dirty], stats };
}

// ---------------------------------------------------------------------------
// Derived intelligence steps (recorded as engine runs for visibility)
// ---------------------------------------------------------------------------
export const ENGINE_IDS = ['engine:recompete', 'engine:enrichment', 'engine:documents', 'engine:ai', 'engine:scoring', 'engine:coverage'] as const;

async function engineRun<T>(deps: SyncDeps, id: string, triggeredBy: string, fn: (runId: string) => Promise<{ message: string; result: T; processed?: number }>): Promise<T | null> {
  const runId = await startRun(deps.db, id, 'derive', triggeredBy, {}, {});
  const started = Date.now();
  try {
    const { message, result, processed } = await fn(runId);
    await deps.db.query(`UPDATE sync_runs SET status = 'success', finished_at = now(), duration_ms = $2, message = $3, records_updated = $4 WHERE id = $1`, [runId, Date.now() - started, message, processed ?? 0]);
    await deps.db.query(`UPDATE source_connectors SET health = 'healthy', health_message = $2, last_success_at = now() WHERE id = $1`, [id, message.slice(0, 500)]);
    return result;
  } catch (err) {
    const msg = errorMessage(err);
    await logSyncError(deps.db, runId, id, 'derive', msg);
    await deps.db.query(`UPDATE sync_runs SET status = 'failed', finished_at = now(), duration_ms = $2, message = $3 WHERE id = $1`, [runId, Date.now() - started, msg]);
    await deps.db.query(`UPDATE source_connectors SET health = 'error', health_message = $2 WHERE id = $1`, [id, msg.slice(0, 500)]);
    deps.log.warn(`${id} failed: ${msg}`);
    return null;
  }
}

export interface PostProcessOptions {
  dirty: Set<string>;
  triggeredBy: string;
  rescoreAll?: boolean;
  runRecompete?: boolean;
}

/** After ingestion: requirements → recompete signals → enrichment → documents → AI → scoring → coverage. */
export async function postProcess(deps: SyncDeps, opts: PostProcessOptions): Promise<void> {
  const { db, config } = deps;
  const priorities = await connectorPriorities(db);
  const dirty = opts.dirty;

  for (const id of dirty) await extractDescriptionRequirements(db, id).catch((err) => deps.log.warn('requirements extraction failed', err));

  if (opts.runRecompete) {
    await engineRun(deps, 'engine:recompete', opts.triggeredBy, async () => {
      const co = await loadCompanyContext(db);
      const r = await runRecompeteEngine(db, co, priorities);
      r.touchedIds.forEach((id) => dirty.add(id));
      return { message: `${r.candidates} relevant expiring contracts · ${r.signalsCreated} new recompete signals · ${r.successorsLinked} linked to successor procurements · ${r.signalsRefreshed} refreshed`, result: r, processed: r.candidates };
    });
  }

  // Score first so enrichment/documents/AI can prioritize the strongest matches.
  const ctx = await prepareScoring(db);
  await scoreMany(db, opts.rescoreAll ? 'all' : [...dirty], opts.triggeredBy, ctx);

  await engineRun(deps, 'engine:enrichment', opts.triggeredBy, async () => {
    const targets = await db.query<{ id: string }>(
      `SELECT id FROM opportunities WHERE id = ANY($1::uuid[]) AND merged_into_id IS NULL AND opportunity_class = 'prime' AND NOT is_signal AND COALESCE(fit_score,0) >= 35
       ORDER BY fit_score DESC NULLS LAST LIMIT $2`,
      [[...dirty], config.enrichPerRun],
    );
    let fetched = 0;
    let incumbents = 0;
    for (const t of targets) {
      const opp = await db.one<any>('SELECT * FROM opportunities WHERE id = $1', [t.id]);
      fetched += await fetchRelatedAwards({ db, http: deps.http, log: deps.log, priorities }, opp);
      const r = await analyzeIncumbency({ db, http: deps.http, log: deps.log, priorities }, t.id);
      incumbents += r.possibleIncumbents;
    }
    return { message: `${targets.length} profiles enriched · ${fetched} related award records retrieved · ${incumbents} possible incumbents identified`, result: null, processed: targets.length };
  });

  await engineRun(deps, 'engine:documents', opts.triggeredBy, async () => {
    const counts = await processPendingDocuments({ db, http: deps.http, config, log: deps.log, budget: deps.budget }, { limit: config.documentsPerRun });
    return { message: Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'No pending documents.', result: counts, processed: Object.values(counts).reduce((s, v) => s + v, 0) };
  });

  const provider = createAiProvider(config);
  if (provider) {
    await engineRun(deps, 'engine:ai', opts.triggeredBy, async () => {
      const targets = await db.query<{ id: string }>(
        `SELECT o.id FROM opportunities o WHERE o.merged_into_id IS NULL AND COALESCE(o.fit_score,0) >= $1 AND o.status IN ('active','forecast','signal')
           AND NOT EXISTS (SELECT 1 FROM ai_analyses a WHERE a.opportunity_id = o.id AND a.status = 'success' AND a.created_at > o.last_changed_at)
         ORDER BY o.fit_score DESC LIMIT $2`,
        [config.aiAutoAnalyzeMinFit, config.aiMaxAnalysesPerRun],
      );
      const outcome: Record<string, number> = {};
      for (const t of targets) {
        const r = await analyzeOpportunity(db, provider, t.id);
        outcome[r.status] = (outcome[r.status] ?? 0) + 1;
        if (r.status === 'success' || r.status === 'cached') dirty.add(t.id);
      }
      return { message: Object.entries(outcome).map(([k, v]) => `${v} ${k}`).join(' · ') || 'Nothing new to analyze.', result: outcome, processed: targets.length };
    });
  } else {
    await db.query(`UPDATE source_connectors SET health = 'not_configured', health_message = 'Set ANTHROPIC_API_KEY to enable AI extraction and summaries.' WHERE id = 'engine:ai'`);
  }

  await engineRun(deps, 'engine:scoring', opts.triggeredBy, async () => {
    for (const id of dirty) await recomputeOpportunity(db, id, { priorities });
    const n = await scoreMany(db, [...dirty], opts.triggeredBy, await prepareScoring(db));
    return { message: `${n} profiles scored`, result: n, processed: n };
  });

  await engineRun(deps, 'engine:coverage', opts.triggeredBy, async () => {
    const co = await loadCompanyContext(db);
    const r = await computeCoverage(db, { companyNaics: co.naics });
    return { message: `${r.open} open coverage signals`, result: r, processed: r.open };
  });
}

// ---------------------------------------------------------------------------
// Orchestration with a single-flight lock
// ---------------------------------------------------------------------------
let active: Promise<unknown> | null = null;
let activeLabel: string | null = null;

export function syncStatus(): { running: boolean; label: string | null } {
  return { running: !!active, label: activeLabel };
}

export async function runAllSources(deps: SyncDeps, opts: { triggeredBy: string; mode?: SyncMode | 'auto' }): Promise<RunSummary[]> {
  const adapters = await listAdapters(deps.db);
  const rows = await deps.db.query<ConnectorRow>('SELECT * FROM source_connectors');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dirty = new Set<string>();
  const results: RunSummary[] = [];
  let usaspendingRan = false;
  for (const a of adapters) {
    const row = byId.get(a.meta.id);
    if (!row?.enabled) continue;
    const mode: SyncMode = opts.mode === 'reconcile' ? (a.fetchReconcile ? 'reconcile' : 'incremental') : 'incremental';
    if (a.meta.id === 'sam_bulk' && opts.mode !== 'reconcile') continue; // bulk is reconciliation-only
    if (a.meta.id === 'sam_opportunities' && mode === 'incremental') {
      // SAM requests go to tracked / high-priority opportunities before general discovery.
      const p = await runSamPriorityChecks(deps, { triggeredBy: opts.triggeredBy }).catch((err) => (deps.log.warn('SAM priority checks failed', err), null));
      p?.dirty.forEach((id) => dirty.add(id));
    }
    try {
      const r = await runConnector(deps, a.meta.id, { mode, triggeredBy: opts.triggeredBy });
      r.dirty.forEach((id) => dirty.add(id));
      if (a.meta.id === 'usaspending' && r.status !== 'skipped') usaspendingRan = true;
      results.push(r);
    } catch (err) {
      deps.log.error(`Connector ${a.meta.id} crashed`, err);
    }
  }
  await postProcess(deps, { dirty, triggeredBy: opts.triggeredBy, runRecompete: usaspendingRan || dirty.size > 0 });
  return results;
}

/** Start work in the background unless something is already running (this process only). */
export function startExclusive(label: string, fn: () => Promise<unknown>, log: Logger): { started: boolean; label: string | null } {
  if (active) return { started: false, label: activeLabel };
  activeLabel = label;
  active = fn()
    .catch((err) => log.error(`${label} failed`, err))
    .finally(() => {
      active = null;
      activeLabel = null;
    });
  return { started: true, label };
}

/**
 * Start source ingestion unless anything is running in THIS process or in ANY other
 * process sharing the database (hosted app, GitHub Actions job, a CLI on a laptop).
 * Holds a renewable database lease for the duration of the work. `done` resolves when the
 * work has finished (CLI callers await it; HTTP handlers return immediately).
 */
export async function startSharedExclusive(
  deps: Pick<SyncDeps, 'db' | 'log'>,
  label: string,
  fn: () => Promise<unknown>,
): Promise<{ started: boolean; label: string | null; elsewhere?: boolean; done?: Promise<void> }> {
  if (active) return { started: false, label: activeLabel };
  let settle!: () => void;
  const placeholder = new Promise<void>((r) => (settle = r));
  active = placeholder;
  activeLabel = label;
  let acquired = false;
  try {
    acquired = await acquireLease(deps.db, label);
  } catch (err) {
    deps.log.warn('Could not acquire the shared sync lease', err);
  }
  if (!acquired) {
    const other = await currentLease(deps.db).catch(() => null);
    active = null;
    activeLabel = null;
    settle();
    return { started: false, label: other ? `${other.label} (on ${other.host})` : 'another GovCheck process', elsewhere: true };
  }
  const heartbeat = setInterval(() => {
    renewLease(deps.db).then(
      (ok) => ok || deps.log.warn('The shared sync lease was lost; another process may start syncing.'),
      (err) => deps.log.warn('Sync lease renewal failed', err),
    );
  }, SYNC_LEASE_TTL_MS / 3);
  heartbeat.unref?.();
  const done = fn()
    .catch((err) => deps.log.error(`${label} failed`, err))
    .finally(async () => {
      clearInterval(heartbeat);
      await releaseLease(deps.db).catch(() => undefined);
      active = null;
      activeLabel = null;
      settle();
    })
    .then(() => undefined);
  active = done;
  return { started: true, label, done };
}

/** In-process status plus any lease held by another process sharing the database. */
export async function sharedSyncStatus(db: Db): Promise<{ running: boolean; label: string | null; elsewhere: boolean }> {
  if (active) return { running: true, label: activeLabel, elsewhere: false };
  const lease = await currentLease(db).catch(() => null);
  return lease ? { running: true, label: `${lease.label} (on ${lease.host})`, elsewhere: true } : { running: false, label: null, elsewhere: false };
}

export async function waitForIdle(): Promise<void> {
  while (active) await active;
}

/**
 * Mark runs left "running" by a crash/restart as failed, so status is never misleading.
 * With a shared database another process may be mid-sync right now (e.g. the GitHub Actions
 * job while the web app wakes up), so nothing is touched while any process holds the sync
 * lease, and recent targeted searches (which run outside the lease) are left alone.
 */
export async function recoverInterruptedRuns(db: Db): Promise<number> {
  if (await currentLease(db).catch(() => null)) return 0;
  const rows = await db.query<{ id: string }>(
    `UPDATE sync_runs SET status = 'failed', finished_at = now(), message = COALESCE(message || ' · ', '') || 'Interrupted (the process stopped before the run finished).'
     WHERE status IN ('running','queued') AND (mode <> 'targeted_search' OR started_at < now() - interval '30 minutes') RETURNING id`,
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Refresh a single opportunity
// ---------------------------------------------------------------------------
export async function refreshOpportunity(deps: SyncDeps, opportunityId: string): Promise<{ steps: { step: string; status: string; message: string }[] }> {
  const { db } = deps;
  const steps: { step: string; status: string; message: string }[] = [];
  const priorities = await connectorPriorities(db);
  const sources = await db.query<{ connector_id: string; source_record_id: string; record_id: string; normalized: any; record_kind: string }>(
    `SELECT sr.connector_id, sr.source_record_id, sr.id AS record_id, sr.normalized, sr.record_kind FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id WHERE os.opportunity_id = $1`,
    [opportunityId],
  );
  const dirty = new Set<string>([opportunityId]);
  const budget = withBudgetMeta(deps.budget, { category: 'manual_refresh', detail: { opportunityId } });
  for (const s of sources) {
    const adapter: SourceAdapter | null = await getAdapter(db, s.connector_id);
    if (!adapter?.fetchByIdentifier) {
      steps.push({ step: s.connector_id, status: 'skipped', message: 'This source does not support single-record refresh; it refreshes with scheduled syncs.' });
      continue;
    }
    const idents: { type: IdentifierType; value: string }[] = s.normalized?.data?.identifiers ?? [];
    const ident = idents.find((i) => adapter.meta.supportsIdentifierFetch.includes(i.type));
    if (!ident) {
      steps.push({ step: s.connector_id, status: 'skipped', message: 'No identifier usable for a targeted refresh.' });
      continue;
    }
    const row = await db.one<ConnectorRow>('SELECT * FROM source_connectors WHERE id = $1', [s.connector_id]);
    const ctx: ConnectorContext = {
      db,
      http: deps.http,
      config: deps.config,
      log: deps.log,
      budget,
      settings: row?.config ?? {},
      focus: await focusFor(db),
      shouldStop: () => false,
      params: {},
    };
    try {
      const posted = s.normalized?.data?.dates?.find((d: any) => d.kind === 'posted')?.value;
      const recs = await adapter.fetchByIdentifier(ctx, ident.type, ident.value, { postedAt: posted });
      const ictx: IngestContext = { db, connectorId: s.connector_id, connectorName: row?.name ?? s.connector_id, adapter, priorities, log: deps.log, dirty, stats: emptyStats() };
      for (const r of recs) await ingestRecord(ictx, r);
      steps.push({ step: s.connector_id, status: 'success', message: `${recs.length} record(s) re-fetched (${ictx.stats.opportunitiesUpdated} updated)` });
    } catch (err) {
      steps.push({ step: s.connector_id, status: 'error', message: errorMessage(err) });
    }
  }

  // Award intelligence by solicitation number / PIID
  const opp = await db.one<any>('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
  if (opp?.solicitation_number && deps.config.samApiKey) {
    const samAwards = await getAdapter(db, 'sam_awards');
    try {
      const recs = await samAwards!.fetchByIdentifier!(
        { db, http: deps.http, config: deps.config, log: deps.log, budget, settings: {}, focus: await focusFor(db), shouldStop: () => false, params: {} },
        'solicitation_number',
        opp.solicitation_number,
      );
      const ictx: IngestContext = { db, connectorId: 'sam_awards', connectorName: 'SAM.gov Contract Awards', adapter: samAwards!, priorities, log: deps.log, dirty, stats: emptyStats() };
      for (const r of recs) await ingestRecord(ictx, r);
      steps.push({ step: 'sam_awards', status: 'success', message: `${recs.length} award transaction(s) found for solicitation ${opp.solicitation_number}` });
    } catch (err) {
      steps.push({ step: 'sam_awards', status: 'error', message: errorMessage(err) });
    }
  }
  if (opp && opp.opportunity_class === 'prime') {
    try {
      const n = await fetchRelatedAwards({ db, http: deps.http, log: deps.log, priorities }, opp);
      const r = await analyzeIncumbency({ db, http: deps.http, log: deps.log, priorities }, opportunityId);
      steps.push({ step: 'usaspending', status: 'success', message: `${n} related award records · ${r.possibleIncumbents} possible incumbent(s) · ${r.comparables} comparable award(s)${r.estimate ? ' · value estimate updated' : ''}` });
    } catch (err) {
      steps.push({ step: 'usaspending', status: 'error', message: errorMessage(err) });
    }
  }
  try {
    const counts = await processPendingDocuments({ db, http: deps.http, config: deps.config, log: deps.log, budget: deps.budget }, { limit: 15, opportunityIds: [opportunityId] });
    steps.push({ step: 'documents', status: 'success', message: Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'No pending documents' });
  } catch (err) {
    steps.push({ step: 'documents', status: 'error', message: errorMessage(err) });
  }
  await extractDescriptionRequirements(db, opportunityId);
  await recomputeOpportunity(db, opportunityId, { priorities });
  await scoreMany(db, [...dirty], 'opportunity refresh');
  steps.push({ step: 'scoring', status: 'success', message: 'Profile recomputed and rescored. Your decisions, notes and tags are untouched.' });
  return { steps };
}
