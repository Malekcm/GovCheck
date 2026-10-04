import type { Db } from '../db';
import { json } from '../db';
import { builtinAdapter } from '../connectors/registry';
import type { Logger } from '../lib/logger';
import { recordSchedulerHeartbeat } from './lease';
import { runSamPriorityChecks, type PriorityRunResult } from './samPriority';
import { postProcess, runConnector, startSharedExclusive, syncStatus, type RunSummary, type SyncDeps } from './sync';

/**
 * Scheduling of incremental source work.
 *
 * GovCheck's normal operating model is: the shared database holds the accumulated
 * intelligence; a scheduler periodically runs ONLY the sources that are due (each source has
 * its own interval and saved cursor), so only new or changed records are processed.
 *
 * The scheduler can be the in-process timer (long-running hosts, SCHEDULER_ENABLED=true),
 * the GitHub Actions workflow running `npm run sync:due` directly against the database, or
 * an external caller of POST /api/cron/sync. All of them share one database lease, so the
 * same source is never ingested by two processes at once.
 */
export interface DueWork {
  incremental: string[];
  reconcile: string[];
}

export interface DueDetail {
  id: string;
  kind: 'incremental' | 'reconcile';
  due: boolean;
  nextAt: string | null;
  reason: string;
}

export async function dueDetails(db: Db, now = Date.now()): Promise<{ onboardingComplete: boolean; details: DueDetail[] }> {
  const company = await db.one<{ onboarding_completed_at: string | null }>('SELECT onboarding_completed_at FROM company_profiles ORDER BY created_at LIMIT 1');
  const rows = await db.query<{ id: string; schedule_minutes: number | null; next_run_at: string | null; config: any; health: string }>(
    `SELECT id, schedule_minutes, next_run_at, config, health FROM source_connectors WHERE enabled AND source_type <> 'engine' ORDER BY priority, id`,
  );
  const details: DueDetail[] = [];
  for (const r of rows) {
    const notConfigured = r.health === 'not_configured';
    if (r.schedule_minutes) {
      const next = r.next_run_at ? new Date(r.next_run_at).getTime() : null;
      const due = !notConfigured && (next === null || next <= now);
      details.push({
        id: r.id,
        kind: 'incremental',
        due,
        nextAt: next ? new Date(next).toISOString() : null,
        reason: notConfigured ? 'Not configured' : due ? (next === null ? 'Never run' : 'Interval elapsed') : 'Not due yet',
      });
    }
    const a = builtinAdapter(r.id);
    const every = Number(r.config?.reconcileEveryMinutes ?? a?.meta.reconcileScheduleMinutes ?? 0);
    if (!every || !a?.fetchReconcile) continue;
    const last = await db.one<{ value: { at: string } }>('SELECT value FROM app_state WHERE key = $1', [`reconcile:${r.id}`]);
    const lastAt = last ? new Date(last.value.at).getTime() : null;
    const nextAt = lastAt === null ? null : lastAt + every * 60_000;
    const due = !notConfigured && (nextAt === null || nextAt <= now);
    details.push({ id: r.id, kind: 'reconcile', due, nextAt: nextAt ? new Date(nextAt).toISOString() : null, reason: notConfigured ? 'Not configured' : due ? (lastAt === null ? 'Never reconciled' : 'Interval elapsed') : 'Not due yet' });
  }
  return { onboardingComplete: !!company?.onboarding_completed_at, details };
}

/** Which sources are due now. Nothing runs before onboarding is complete (the first pull should reflect the profile). */
export async function dueWork(db: Db, now = Date.now()): Promise<DueWork> {
  const { onboardingComplete, details } = await dueDetails(db, now);
  if (!onboardingComplete) return { incremental: [], reconcile: [] };
  return {
    incremental: details.filter((d) => d.kind === 'incremental' && d.due).map((d) => d.id),
    reconcile: details.filter((d) => d.kind === 'reconcile' && d.due).map((d) => d.id),
  };
}

export interface DueRunReport {
  work: DueWork;
  results: Pick<RunSummary, 'connectorId' | 'status' | 'message' | 'stats'>[];
  priority: PriorityRunResult | null;
  dirty: number;
}

/** Run exactly the given due work, then the derived-intelligence steps for what changed. */
export async function executeDueWork(deps: SyncDeps, work: DueWork, triggeredBy: string): Promise<DueRunReport> {
  const dirty = new Set<string>();
  const results: DueRunReport['results'] = [];
  let recompete = false;
  let priority: PriorityRunResult | null = null;
  for (const id of work.incremental) {
    if (id === 'sam_opportunities') {
      // Spend SAM requests on tracked / high-priority opportunities before general discovery.
      priority = await runSamPriorityChecks(deps, { triggeredBy }).catch((err) => {
        deps.log.warn('SAM priority checks failed', err);
        return null;
      });
      priority?.dirty.forEach((d) => dirty.add(d));
    }
    const res = await runConnector(deps, id, { mode: 'incremental', triggeredBy });
    res.dirty.forEach((d) => dirty.add(d));
    results.push({ connectorId: res.connectorId, status: res.status, message: res.message, stats: res.stats });
    if (id === 'usaspending') recompete = true;
  }
  for (const id of work.reconcile) {
    const res = await runConnector(deps, id, { mode: 'reconcile', triggeredBy });
    res.dirty.forEach((d) => dirty.add(d));
    results.push({ connectorId: `${res.connectorId} (reconcile)`, status: res.status, message: res.message, stats: res.stats });
    if (res.status !== 'failed')
      await deps.db.query(`INSERT INTO app_state (key, value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [
        `reconcile:${id}`,
        json({ at: new Date().toISOString(), runId: res.runId }),
      ]);
  }
  await postProcess(deps, { dirty, triggeredBy, runRecompete: recompete || dirty.size > 0 });
  await recordSchedulerHeartbeat(deps.db, triggeredBy, { ran: [...work.incremental, ...work.reconcile.map((r) => `${r} (reconcile)`)], changedProfiles: dirty.size }).catch(() => undefined);
  return { work, results, priority, dirty: dirty.size };
}

/** Start due work in the background (HTTP handlers, in-process timer). */
export async function runDueWork(deps: SyncDeps, triggeredBy: string): Promise<{ started: boolean; work: DueWork; label?: string | null }> {
  const work = await dueWork(deps.db);
  if (!work.incremental.length && !work.reconcile.length) {
    await recordSchedulerHeartbeat(deps.db, triggeredBy, { ran: [], changedProfiles: 0 }).catch(() => undefined);
    return { started: false, work };
  }
  const r = await startSharedExclusive(deps, `${triggeredBy}: due sources`, () => executeDueWork(deps, work, triggeredBy));
  return { started: r.started, work, label: r.started ? undefined : r.label };
}

/**
 * Run due work in the foreground and wait for it (CLI / GitHub Actions). Holds the shared
 * lease for the whole run; returns started=false if another process is already syncing.
 */
export async function runDueWorkNow(deps: SyncDeps, triggeredBy: string): Promise<{ started: boolean; label?: string | null; report?: DueRunReport; work: DueWork }> {
  const work = await dueWork(deps.db);
  if (!work.incremental.length && !work.reconcile.length) {
    await recordSchedulerHeartbeat(deps.db, triggeredBy, { ran: [], changedProfiles: 0 }).catch(() => undefined);
    return { started: true, work, report: { work, results: [], priority: null, dirty: 0 } };
  }
  let report: DueRunReport | undefined;
  let failure: unknown = null;
  const r = await startSharedExclusive(deps, `${triggeredBy}: due sources`, async () => {
    try {
      report = await executeDueWork(deps, work, triggeredBy);
    } catch (err) {
      failure = err;
    }
  });
  if (!r.started) return { started: false, label: r.label, work };
  await r.done;
  if (failure) throw failure;
  return { started: true, report, work };
}

export function startScheduler(deps: SyncDeps, log: Logger, intervalMs = 5 * 60_000): () => void {
  const tick = async () => {
    if (syncStatus().running) return;
    try {
      const r = await runDueWork(deps, 'schedule');
      if (r.started) log.info(`Scheduled sync started: ${[...r.work.incremental, ...r.work.reconcile.map((x) => `${x} (reconcile)`)].join(', ')}`);
      else if (r.label) log.info(`Due sources skipped — already running: ${r.label}`);
    } catch (err) {
      log.error('Scheduler tick failed', err);
    }
  };
  const handle = setInterval(tick, intervalMs);
  setTimeout(tick, 30_000);
  return () => clearInterval(handle);
}
