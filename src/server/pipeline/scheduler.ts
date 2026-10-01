import type { Db } from '../db';
import { json } from '../db';
import { builtinAdapter } from '../connectors/registry';
import type { Logger } from '../lib/logger';
import { postProcess, runConnector, startExclusive, syncStatus, type SyncDeps } from './sync';

/**
 * In-process scheduler for long-running Node hosts. Runs due incremental syncs and
 * periodic reconciliations. Scheduled runs only start after onboarding is complete so the
 * first data pull reflects the user's profile. External schedulers can instead call
 * POST /api/cron/sync with the CRON_SECRET.
 */
export async function dueWork(db: Db): Promise<{ incremental: string[]; reconcile: string[] }> {
  const company = await db.one<{ onboarding_completed_at: string | null }>('SELECT onboarding_completed_at FROM company_profiles ORDER BY created_at LIMIT 1');
  if (!company?.onboarding_completed_at) return { incremental: [], reconcile: [] };
  const rows = await db.query<{ id: string; schedule_minutes: number | null; next_run_at: string | null; config: any }>(
    `SELECT id, schedule_minutes, next_run_at, config FROM source_connectors WHERE enabled AND source_type <> 'engine' AND health <> 'not_configured'`,
  );
  const now = Date.now();
  const incremental = rows.filter((r) => r.schedule_minutes && (!r.next_run_at || new Date(r.next_run_at).getTime() <= now)).map((r) => r.id);
  const reconcile: string[] = [];
  for (const r of rows) {
    const a = builtinAdapter(r.id);
    const every = Number(r.config?.reconcileEveryMinutes ?? a?.meta.reconcileScheduleMinutes ?? 0);
    if (!every || !a?.fetchReconcile) continue;
    const last = await db.one<{ value: { at: string } }>('SELECT value FROM app_state WHERE key = $1', [`reconcile:${r.id}`]);
    if (!last || now - new Date(last.value.at).getTime() >= every * 60_000) reconcile.push(r.id);
  }
  return { incremental, reconcile };
}

export async function runDueWork(deps: SyncDeps, triggeredBy: string): Promise<{ started: boolean; work: { incremental: string[]; reconcile: string[] } }> {
  const work = await dueWork(deps.db);
  if (!work.incremental.length && !work.reconcile.length) return { started: false, work };
  const r = startExclusive(
    `${triggeredBy} sync`,
    async () => {
      const dirty = new Set<string>();
      let recompete = false;
      for (const id of work.incremental) {
        const res = await runConnector(deps, id, { mode: 'incremental', triggeredBy });
        res.dirty.forEach((d) => dirty.add(d));
        if (id === 'usaspending') recompete = true;
      }
      for (const id of work.reconcile) {
        const res = await runConnector(deps, id, { mode: 'reconcile', triggeredBy });
        res.dirty.forEach((d) => dirty.add(d));
        if (res.status !== 'failed')
          await deps.db.query(`INSERT INTO app_state (key, value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [
            `reconcile:${id}`,
            json({ at: new Date().toISOString(), runId: res.runId }),
          ]);
      }
      await postProcess(deps, { dirty, triggeredBy, runRecompete: recompete || dirty.size > 0 });
    },
    deps.log,
  );
  return { started: r.started, work };
}

export function startScheduler(deps: SyncDeps, log: Logger, intervalMs = 5 * 60_000): () => void {
  const tick = async () => {
    if (syncStatus().running) return;
    try {
      const r = await runDueWork(deps, 'schedule');
      if (r.started) log.info(`Scheduled sync started: ${[...r.work.incremental, ...r.work.reconcile.map((x) => `${x} (reconcile)`)].join(', ')}`);
    } catch (err) {
      log.error('Scheduler tick failed', err);
    }
  };
  const handle = setInterval(tick, intervalMs);
  setTimeout(tick, 30_000);
  return () => clearInterval(handle);
}
